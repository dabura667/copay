'use strict';
var imports = require('soop').imports();

var http = require('http');
var EventEmitter = imports.EventEmitter || require('events').EventEmitter;
var async = require('async');
var preconditions = require('preconditions').singleton();

var bitcore = require('bitcore');
var bignum = bitcore.Bignum;
var coinUtil = bitcore.util;
var buffertools = bitcore.buffertools;
var Builder = bitcore.TransactionBuilder;
var SecureRandom = bitcore.SecureRandom;
var Base58Check = bitcore.Base58.base58Check;
var Address = bitcore.Address;

var HDParams = require('./HDParams');
var PublicKeyRing = require('./PublicKeyRing');
var TxProposal = require('./TxProposal');
var TxProposals = require('./TxProposals');
var PrivateKey = require('./PrivateKey');
var copayConfig = require('../../../config');

function Wallet(opts) {
  var self = this;

  //required params
  ['storage', 'network', 'blockchain',
    'requiredCopayers', 'totalCopayers', 'spendUnconfirmed',
    'publicKeyRing', 'txProposals', 'privateKey', 'version',
    'reconnectDelay'
  ].forEach(function(k) {
    if (typeof opts[k] === 'undefined')
      throw new Error('missing required option for Wallet: ' + k);
    self[k] = opts[k];
  });
  if (copayConfig.forceNetwork && this.getNetworkName() !== copayConfig.networkName)
    throw new Error('Network forced to ' + copayConfig.networkName +
                    ' and tried to create a Wallet with network ' + this.getNetworkName());

  this.log('creating ' + opts.requiredCopayers + ' of ' + opts.totalCopayers + ' wallet');

  this.id = opts.id || Wallet.getRandomId();
  this.name = opts.name;

  this.verbose = opts.verbose;
  this.publicKeyRing.walletId = this.id;
  this.txProposals.walletId = this.id;
  this.network.maxPeers = this.totalCopayers;
  this.registeredPeerIds = [];
  this.addressBook = opts.addressBook || {};
  this.publicKey = this.privateKey.publicHex;

  //network nonces are 8 byte buffers, representing a big endian number
  //one nonce for oneself, and then one nonce for each copayer
  this.network.setHexNonce(opts.networkNonce);
  this.network.setHexNonces(opts.networkNonces);
}


Wallet.builderOpts = {
  lockTime: null,
  signhash: bitcore.Transaction.SIGNHASH_ALL,
  fee: null,
  feeSat: null,
};

Wallet.parent = EventEmitter;
Wallet.prototype.log = function() {
  if (!this.verbose) return;
  if (console)
    console.log.apply(console, arguments);
};

Wallet.getRandomId = function() {
  var r = bitcore.SecureRandom.getPseudoRandomBuffer(8).toString('hex');
  return r;
};

Wallet.prototype.seedCopayer = function(pubKey) {
  this.seededCopayerId = pubKey;
};

Wallet.prototype.connectToAll = function() {

  var all = this.publicKeyRing.getAllCopayerIds();
  this.network.connectToCopayers(all);
  if (this.seededCopayerId) {
    this.sendWalletReady(this.seededCopayerId);
    this.seededCopayerId = null;
  }
};

Wallet.prototype._handleIndexes = function(senderId, data, isInbound) {
  this.log('RECV INDEXES:', data);
  var inIndexes = HDParams.fromList(data.indexes);
  var hasChanged = this.publicKeyRing.mergeIndexes(inIndexes);
  if (hasChanged) {
    this.emit('publicKeyRingUpdated');
    this.store();
  }
};

Wallet.prototype._handlePublicKeyRing = function(senderId, data, isInbound) {
  this.log('RECV PUBLICKEYRING:', data);

  var inPKR = PublicKeyRing.fromObj(data.publicKeyRing);
  var wasIncomplete = !this.publicKeyRing.isComplete();
  var hasChanged;

  try {
    hasChanged = this.publicKeyRing.merge(inPKR, true);
  } catch (e) {
    this.log('## WALLET ERROR', e); //TODO
    this.emit('connectionError', e.message);
    return;
  }

  if (hasChanged) {
    if (wasIncomplete) {
      this.sendPublicKeyRing();
    }
    if (this.publicKeyRing.isComplete()) {
      this._lockIncomming();
    }
    this.emit('publicKeyRingUpdated');
    this.store();
  }
};


Wallet.prototype._processProposalEvents = function(senderId, m) {
  var ev;
  if (m) {
    if (m.new) {
      ev = {
        type: 'new',
        cid: senderId
      }
    } else if (m.newCopayer) {
      ev = {
        type: 'signed',
        cid: m.newCopayer
      };
    }
  } else {
    ev = {
      type: 'corrupt',
      cId: senderId,
    };
  }

  if (ev)
    this.emit('txProposalEvent', ev);
};



/* OTDO
   events.push({
type: 'signed',
cId: k,
txId: ntxid
});
*/
Wallet.prototype._getKeyMap = function(txp) {
  preconditions.checkArgument(txp);

  var keyMap = this.publicKeyRing.copayersForPubkeys(txp._inputSignatures[0], txp.inputChainPaths);

  var inSig = JSON.stringify(txp._inputSignatures[0].sort());

  if (JSON.stringify(Object.keys(keyMap).sort()) !== inSig) {
    throw new Error('inputSignatures dont match know copayers pubkeys');
  }

  var keyMapStr = JSON.stringify(keyMap);
  // All inputs must be signed with the same copayers
  for (var i in txp._inputSignatures) {
    if (!i) continue;
    var inSigX = JSON.stringify(txp._inputSignatures[i].sort());
    if (inSigX !== inSig)
      throw new Error('found inputs with different signatures:');
  }
  return keyMap;
};


Wallet.prototype._checkSentTx = function(ntxid, cb) {
  var txp = this.txProposals.get(ntxid);
  var tx = txp.builder.build();

  this.blockchain.checkSentTx(tx, function(err, txid) {
    var ret = false;
    if (txid) {
      txp.setSent(txid);
      ret = txid;
    }
    return cb(ret);
  });
};


Wallet.prototype._handleTxProposal = function(senderId, data) {
  var self = this;
  this.log('RECV TXPROPOSAL: ', data);
  var m;

  try {
    m = this.txProposals.merge(data.txProposal, Wallet.builderOpts);
    var keyMap = this._getKeyMap(m.txp);
    ret.newCopayer = m.txp.setCopayers(senderId, keyMap);

  } catch (e) {
    this.log('Corrupt TX proposal received from:', senderId, e);
  }

  if (m) {

    if (m.hasChanged) {
      this.sendSeen(m.ntxid);
      var tx = m.txp.builder.build();
      if (tx.isComplete()) {
        this._checkSentTx(m.ntxid, function(ret) {
          if (ret) {
            self.emit('txProposalsUpdated');
            self.store();
          }
        });
      } else {
        this.sendTxProposal(m.ntxid);
      }
    }
    this.emit('txProposalsUpdated');
    this.store();
  }
  this._processProposalEvents(senderId, m);
};


Wallet.prototype._handleReject = function(senderId, data, isInbound) {
  preconditions.checkState(data.ntxid);
  this.log('RECV REJECT:', data);

  var txp = this.txProposals.get(data.ntxid);

  if (!txp)
    throw new Error('Received Reject for an unknown TX from:' + senderId);

  if (txp.signedBy[senderId])
    throw new Error('Received Reject for an already signed TX from:' + senderId);

  txp.setRejected(senderId);
  this.store();

  this.emit('txProposalsUpdated');
  this.emit('txProposalEvent', {
    type: 'rejected',
    cId: senderId,
    txId: data.ntxid,
  });
};

Wallet.prototype._handleSeen = function(senderId, data, isInbound) {
  preconditions.checkState(data.ntxid);
  this.log('RECV SEEN:', data);

  var txp = this.txProposals.get(data.ntxid);
  txp.setSeen(senderId);
  this.store();
  this.emit('txProposalsUpdated');
  this.emit('txProposalEvent', {
    type: 'seen',
    cId: senderId,
    txId: data.ntxid,
  });

};



Wallet.prototype._handleAddressBook = function(senderId, data, isInbound) {
  preconditions.checkState(data.addressBook);
  this.log('RECV ADDRESSBOOK:', data);
  var rcv = data.addressBook;
  var hasChange;
  for (var key in rcv) {
    if (!this.addressBook[key]) {
      var isVerified = this.verifyAddressbookEntry(rcv[key], senderId, key);
      if (isVerified) {
        this.addressBook[key] = rcv[key];
        hasChange = true;
      }
    }
  }
  if (hasChange) {
    this.emit('addressBookUpdated');
    this.store();
  }
};

Wallet.prototype._handleData = function(senderId, data, isInbound) {

  // TODO check message signature

  if (data.type !== 'walletId' && this.id !== data.walletId) {
    this.emit('badMessage', senderId);
    this.log('badMessage FROM:', senderId); //TODO
    return;
  }
  switch (data.type) {
    // This handler is repeaded on WalletFactory (#join). TODO
    case 'walletId':
      this.sendWalletReady(senderId);
    break;
    case 'walletReady':
      this.sendPublicKeyRing(senderId);
    this.sendAddressBook(senderId);
    this.sendAllTxProposals(senderId); // send old txps
    break;
    case 'publicKeyRing':
      this._handlePublicKeyRing(senderId, data, isInbound);
    break;
    case 'reject':
      this._handleReject(senderId, data, isInbound);
    break;
    case 'seen':
      this._handleSeen(senderId, data, isInbound);
    break;
    case 'txProposal':
      this._handleTxProposal(senderId, data, isInbound);
    break;
    case 'indexes':
      this._handleIndexes(senderId, data, isInbound);
    break;
    case 'addressbook':
      this._handleAddressBook(senderId, data, isInbound);
    break;
  }
};

Wallet.prototype._handleConnect = function(newCopayerId) {
  if (newCopayerId) {
    this.log('#### Setting new COPAYER:', newCopayerId);
    this.sendWalletId(newCopayerId);
  }
  var peerID = this.network.peerFromCopayer(newCopayerId)
  this.emit('connect', peerID);
};

Wallet.prototype._handleDisconnect = function(peerID) {
  this.currentDelay = null;
  this.emit('disconnect', peerID);
};


Wallet.prototype.getNetworkName = function() {
  return this.publicKeyRing.network.name;
};

Wallet.prototype._optsToObj = function() {
  var obj = {
    id: this.id,
    spendUnconfirmed: this.spendUnconfirmed,
    requiredCopayers: this.requiredCopayers,
    totalCopayers: this.totalCopayers,
    name: this.name,
    version: this.version,
  };

  return obj;
};


Wallet.prototype.getCopayerId = function(index) {
  return this.publicKeyRing.getCopayerId(index || 0);
};


Wallet.prototype.getMyCopayerId = function() {
  return this.getCopayerId(0); //copayer id is hex of a public key
};

Wallet.prototype.getMyCopayerIdPriv = function() {
  return this.privateKey.getIdPriv(); //copayer idpriv is hex of a private key
};

Wallet.prototype.getSecret = function() {
  var pubkeybuf = new Buffer(this.getMyCopayerId(), 'hex');
  var str = Base58Check.encode(pubkeybuf);
  return str;
};


Wallet.decodeSecret = function(secretB) {
  var secret = Base58Check.decode(secretB);
  var pubKeyBuf = secret.slice(0, 33);
  return {
    pubKey: pubKeyBuf.toString('hex')
  }
};


Wallet.prototype._lockIncomming = function() {
  this.network.lockIncommingConnections(this.publicKeyRing.getAllCopayerIds());
};

Wallet.prototype.netStart = function(callback) {
  var self = this;
  var net = this.network;
  net.removeAllListeners();
  net.on('connect', self._handleConnect.bind(self));
  net.on('disconnect', self._handleDisconnect.bind(self));
  net.on('data', self._handleData.bind(self));
  net.on('close', function() {
    self.emit('close');
  });
  net.on('serverError', function(msg) {
    self.emit('serverError', msg);
  });

  var myId = self.getMyCopayerId();
  var myIdPriv = self.getMyCopayerIdPriv();

  var startOpts = {
    copayerId: myId,
    privkey: myIdPriv,
    maxPeers: self.totalCopayers
  };

  if (this.publicKeyRing.isComplete()) {
    this._lockIncomming();
  }

  net.start(startOpts, function() {
    self.emit('ready', net.getPeer());
    setTimeout(function() {
      self.emit('publicKeyRingUpdated', true);
      self.scheduleConnect();
      self.emit('txProposalsUpdated');
    }, 10);
  });
};

Wallet.prototype.scheduleConnect = function() {
  var self = this;
  if (self.network.isOnline()) {
    self.connectToAll();
    self.currentDelay = self.currentDelay * 2 || self.reconnectDelay;
    setTimeout(self.scheduleConnect.bind(self), self.currentDelay);
  }
}

Wallet.prototype.getOnlinePeerIDs = function() {
  return this.network.getOnlinePeerIDs();
};

Wallet.prototype.getRegisteredCopayerIds = function() {
  var l = this.publicKeyRing.registeredCopayers();
  var copayers = [];
  for (var i = 0; i < l; i++) {
    var cid = this.getCopayerId(i);
    copayers.push(cid);
  }
  return copayers;
};

Wallet.prototype.getRegisteredPeerIds = function() {
  var l = this.publicKeyRing.registeredCopayers();
  if (this.registeredPeerIds.length !== l) {
    this.registeredPeerIds = [];
    var copayers = this.getRegisteredCopayerIds();
    for (var i = 0; i < l; i++) {
      var cid = copayers[i];
      var pid = this.network.peerFromCopayer(cid);
      this.registeredPeerIds.push({
        peerId: pid,
        copayerId: cid,
        nick: this.publicKeyRing.nicknameForCopayer(cid),
        index: i,
      });
    }
  }
  return this.registeredPeerIds;
};

Wallet.prototype.store = function() {
  var wallet = this.toObj();
  this.storage.setFromObj(this.id, wallet);
  this.log('Wallet stored');
};

Wallet.prototype.toObj = function() {
  var optsObj = this._optsToObj();

  var networkNonce = this.network.getHexNonce();
  var networkNonces = this.network.getHexNonces();

  var walletObj = {
    opts: optsObj,
    networkNonce: networkNonce, //yours
    networkNonces: networkNonces, //copayers
    publicKeyRing: this.publicKeyRing.toObj(),
    txProposals: this.txProposals.toObj(),
    privateKey: this.privateKey ? this.privateKey.toObj() : undefined,
    addressBook: this.addressBook,
  };

  return walletObj;
};

// fromObj => from a trusted source
Wallet.fromObj = function(o, storage, network, blockchain) {
  var opts = JSON.parse(JSON.stringify(o.opts));
  opts.addressBook = o.addressBook;

  opts.publicKeyRing = PublicKeyRing.fromObj(o.publicKeyRing);
  opts.txProposals = TxProposals.fromObj(o.txProposals, Wallet.builderOpts);
  opts.privateKey = PrivateKey.fromObj(o.privateKey);

  opts.storage = storage;
  opts.network = network;
  opts.blockchain = blockchain;
  var w = new Wallet(opts);
  return w;
};

Wallet.prototype.toEncryptedObj = function() {
  var walletObj = this.toObj();
  return this.storage.export(walletObj);
};

Wallet.prototype.send = function(recipients, obj) {
  this.network.send(recipients, obj);
};

Wallet.prototype.sendAllTxProposals = function(recipients) {
  var ntxids = this.txProposals.getNtxids();
  for (var i in ntxids) {
    var ntxid = ntxids[i];
    this.sendTxProposal(ntxid, recipients);
  }
};

Wallet.prototype.sendTxProposal = function(ntxid, recipients) {
  preconditions.checkArgument(ntxid);

  this.log('### SENDING txProposal ' + ntxid + ' TO:', recipients || 'All', this.txProposals);
  this.send(recipients, {
    type: 'txProposal',
    txProposal: this.txProposals.get(ntxid).toObjTrim(),
    walletId: this.id,
  });
};

Wallet.prototype.sendSeen = function(ntxid) {
  preconditions.checkArgument(ntxid);
  this.log('### SENDING seen:  ' + ntxid + ' TO: All');
  this.send(null, {
    type: 'seen',
    ntxid: ntxid,
    walletId: this.id,
  });
};

Wallet.prototype.sendReject = function(ntxid) {
  preconditions.checkArgument(ntxid);
  this.log('### SENDING reject:  ' + ntxid + ' TO: All');
  this.send(null, {
    type: 'reject',
    ntxid: ntxid,
    walletId: this.id,
  });
};

Wallet.prototype.sendWalletReady = function(recipients) {
  this.log('### SENDING WalletReady TO:', recipients);

  this.send(recipients, {
    type: 'walletReady',
    walletId: this.id,
  });
};

Wallet.prototype.sendWalletId = function(recipients) {
  this.log('### SENDING walletId TO:', recipients || 'All', this.id);

  this.send(recipients, {
    type: 'walletId',
    walletId: this.id,
    opts: this._optsToObj(),
    networkName: this.getNetworkName(),
  });
};


Wallet.prototype.sendPublicKeyRing = function(recipients) {
  this.log('### SENDING publicKeyRing TO:', recipients || 'All', this.publicKeyRing.toObj());
  var publicKeyRing = this.publicKeyRing.toObj();
  delete publicKeyRing.publicKeysCache; // exclude publicKeysCache from network obj

  this.send(recipients, {
    type: 'publicKeyRing',
    publicKeyRing: publicKeyRing,
    walletId: this.id,
  });
};
Wallet.prototype.sendIndexes = function(recipients) {
  var indexes = HDParams.serialize(this.publicKeyRing.indexes);
  this.log('### INDEXES TO:', recipients || 'All', indexes);

  this.send(recipients, {
    type: 'indexes',
    indexes: indexes,
    walletId: this.id,
  });
};

Wallet.prototype.sendAddressBook = function(recipients) {
  this.log('### SENDING addressBook TO:', recipients || 'All', this.addressBook);
  this.send(recipients, {
    type: 'addressbook',
    addressBook: this.addressBook,
    walletId: this.id,
  });
};

Wallet.prototype.getName = function() {
  return this.name || this.id;
};

Wallet.prototype._doGenerateAddress = function(isChange) {
  return this.publicKeyRing.generateAddress(isChange, this.publicKey);
};


Wallet.prototype.generateAddress = function(isChange, cb) {
  var addr = this._doGenerateAddress(isChange);
  this.sendIndexes();
  this.store();
  if (cb) return cb(addr);
  return addr;
};


Wallet.prototype.getTxProposals = function() {
  var ret = [];
  var copayers = this.getRegisteredCopayerIds();
  for (var ntxid in this.txProposals.txps) {
    var txp = this.txProposals.getTxProposal(ntxid, copayers);
    txp.signedByUs = txp.signedBy[this.getMyCopayerId()] ? true : false;
    txp.rejectedByUs = txp.rejectedBy[this.getMyCopayerId()] ? true : false;
    if (this.totalCopayers - txp.rejectCount < this.requiredCopayers) {
      txp.finallyRejected = true;
    }

    if (txp.readonly && !txp.finallyRejected && !txp.sentTs) {} else {
      ret.push(txp);
    }
  }
  return ret;
};


Wallet.prototype.reject = function(ntxid) {
  var txp = this.txProposals.reject(ntxid, this.getMyCopayerId());
  this.sendReject(ntxid);
  this.store();
  this.emit('txProposalsUpdated');
};

Wallet.prototype.sign = function(ntxid, cb) {
  preconditions.checkState(typeof this.getMyCopayerId() !== 'undefined');
  var self = this;
  setTimeout(function() {
    var myId = self.getMyCopayerId();
    var txp =  self.txProposals.get(ntxid);
    // if (!txp || txp.rejectedBy[myId] || txp.signedBy[myId]) {
    //   if (cb) cb(false);
    // }
    //
    var keys = self.privateKey.getForPaths(txp.inputChainPaths);

    var b = txp.builder;
    var before = txp.countSignatures();
    b.sign(keys);

    var ret = false;
    if (txp.countSignatures() > before) {
      txp.signedBy[myId] = Date.now();
      self.sendTxProposal(ntxid);
      self.store();
      self.emit('txProposalsUpdated');
      ret = true;
    }
    if (cb) return cb(ret);
  }, 10);
};


Wallet.prototype.sendTx = function(ntxid, cb) {
  var txp = this.txProposals.get(ntxid);
  var tx = txp.builder.build();
  if (!tx.isComplete())
    throw new Error('Tx is not complete. Can not broadcast');
  this.log('Broadcasting Transaction');
  var scriptSig = tx.ins[0].getScript();
  var size = scriptSig.serialize().length;

  var txHex = tx.serialize().toString('hex');
  this.log('Raw transaction: ', txHex);

  var self = this;
  this.blockchain.sendRawTransaction(txHex, function(txid) {
    self.log('BITCOIND txid:', txid);
    if (txid) {
      self.txProposals.get(ntxid).setSent(txid);
      self.sendTxProposal(ntxid);
      self.store();
      return cb(txid);
    } else {
      self.log('Sent failed. Checking is the TX was sent already');
      self._checkSentTx(ntxid, function(txid) {
        console.log('[Wallet.js.730:txid:]', txid); //TODO
        if (txid)
          self.store();

        return cb(txid);
      });
    }
  });
};


// TODO: remove this method and use getAddressesInfo everywhere
Wallet.prototype.getAddresses = function(opts) {
  return this.publicKeyRing.getAddresses(opts);
};

Wallet.prototype.getAddressesStr = function(opts) {
  return this.getAddresses(opts).map(function(a) {
    return a.toString();
  });
};

Wallet.prototype.getAddressesInfo = function(opts) {
  return this.publicKeyRing.getAddressesInfo(opts, this.publicKey);
};

Wallet.prototype.addressIsOwn = function(addrStr, opts) {
  var addrList = this.getAddressesStr(opts);
  var l = addrList.length;
  var ret = false;

  for (var i = 0; i < l; i++) {
    if (addrList[i] === addrStr) {
      ret = true;
      break;
    }
  }
  return ret;
};

//retunrs values in SATOSHIs
Wallet.prototype.getBalance = function(cb) {
  var balance = 0;
  var safeBalance = 0;
  var balanceByAddr = {};
  var COIN = coinUtil.COIN;

  this.getUnspent(function(err, safeUnspent, unspent) {
    if (err) {
      return cb(err);
    }

    for (var i = 0; i < unspent.length; i++) {
      var u = unspent[i];
      var amt = u.amount * COIN;
      balance += amt;
      balanceByAddr[u.address] = (balanceByAddr[u.address] || 0) + amt;
    }

    // we multiply and divide by BIT to avoid rounding errors when adding
    for (var a in balanceByAddr) {
      balanceByAddr[a] = parseInt(balanceByAddr[a].toFixed(0));
    }

    balance = parseInt(balance.toFixed(0));

    for (var i = 0; i < safeUnspent.length; i++) {
      var u = safeUnspent[i];
      var amt = u.amount * COIN;
      safeBalance += amt;
    }

    safeBalance = parseInt(safeBalance.toFixed(0));
    return cb(null, balance, balanceByAddr, safeBalance);
  });
};

Wallet.prototype.getUnspent = function(cb) {
  var self = this;
  this.blockchain.getUnspent(this.getAddressesStr(), function(err, unspentList) {

    if (err) {
      return cb(err);
    }

    var safeUnspendList = [];
    var maxRejectCount = self.totalCopayers - self.requiredCopayers;
    var uu = self.txProposals.getUsedUnspent(maxRejectCount);

    for (var i in unspentList) {
      var u = unspentList[i];
      var name = u.txid + ',' + u.vout;
      if (!uu[name] && (self.spendUnconfirmed || u.confirmations >= 1))
        safeUnspendList.push(u);
    }

    return cb(null, safeUnspendList, unspentList);
  });
};


Wallet.prototype.createTx = function(toAddress, amountSatStr, comment, opts, cb) {
  var self = this;
  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  opts = opts || {};

  if (typeof opts.spendUnconfirmed === 'undefined') {
    opts.spendUnconfirmed = this.spendUnconfirmed;
  }

  this.getUnspent(function(err, safeUnspent) {
    var ntxid = self.createTxSync(toAddress, amountSatStr, comment, safeUnspent, opts);
    if (ntxid) {
      self.sendIndexes();
      self.sendTxProposal(ntxid);
      self.store();
      self.emit('txProposalsUpdated');
    }
    return cb(ntxid);
  });
};

Wallet.prototype.createTxSync = function(toAddress, amountSatStr, comment, utxos, opts) {
  var pkr = this.publicKeyRing;
  var priv = this.privateKey;
  opts = opts || {};

  preconditions.checkArgument(new Address(toAddress).network().name === this.getNetworkName(), 'networkname mismatch');
  preconditions.checkState(pkr.isComplete(), 'pubkey ring incomplete');
  preconditions.checkState(priv, 'no private key');
  if (comment) preconditions.checkArgument(comment.length <= 100);

  if (!opts.remainderOut) {
    opts.remainderOut = {
      address: this._doGenerateAddress(true).toString()
    };
  }

  for (var k in Wallet.builderOpts) {
    opts[k] = Wallet.builderOpts[k];
  }

  var b = new Builder(opts)
  .setUnspent(utxos)
  .setOutputs([{
    address: toAddress,
    amountSatStr: amountSatStr,
  }]);

  var selectedUtxos = b.getSelectedUnspent();
  var inputChainPaths = selectedUtxos.map(function(utxo) {
    return pkr.pathForAddress(utxo.address);
  });

  b = b.setHashToScriptMap(pkr.getRedeemScriptMap(inputChainPaths));

  var keys = priv.getForPaths(inputChainPaths);
  var signed = b.sign(keys);
  var myId = this.getMyCopayerId();
  var now = Date.now();


  var tx = b.build();
  if (!tx.countInputSignatures(0))
    throw new Error('Could not sign generated tx');

  var me = {};
  me[myId] = now;

  var meSeen = {};
  if (priv) meSeen[myId] = now;

  var ntxid = this.txProposals.add(new TxProposal({
    inputChainPaths: inputChainPaths,
    signedBy: me,
    seenBy: meSeen,
    creator: myId,
    createdTs: now,
    builder: b,
    comment: comment
  }));
  return ntxid;
};

Wallet.prototype.updateIndexes = function(callback) {
  var self = this;
  self.log('Updating indexes...');

  var tasks = this.publicKeyRing.indexes.map(function(index) {
    return function(callback) {
      self.updateIndex(index, callback);
    };
  });

  async.parallel(tasks, function(err) {
    if (err) callback(err);
    self.log('Indexes updated');
    self.emit('publicKeyRingUpdated');
    self.store();
    callback();
  });
}

Wallet.prototype.updateIndex = function(index, callback) {
  var self = this;
  var SCANN_WINDOW = 20;
  self.indexDiscovery(index.changeIndex, true, index.cosigner, SCANN_WINDOW, function(err, changeIndex) {
    if (err) return callback(err);
    if (changeIndex != -1)
      index.changeIndex = changeIndex + 1;

    self.indexDiscovery(index.receiveIndex, false, index.cosigner, SCANN_WINDOW, function(err, receiveIndex) {
      if (err) return callback(err);
      if (receiveIndex != -1)
        index.receiveIndex = receiveIndex + 1;
      callback();
    });
  });
}

Wallet.prototype.deriveAddresses = function(index, amout, isChange, cosigner) {
  var ret = new Array(amout);
  for (var i = 0; i < amout; i++) {
    ret[i] = this.publicKeyRing.getAddress(index + i, isChange, cosigner).toString();
  }
  return ret;
}

// This function scans the publicKeyRing branch starting at index @start and reports the index with last activity,
// using a scan window of @gap. The argument @change defines the branch to scan: internal or external.
// Returns -1 if no activity is found in range.
Wallet.prototype.indexDiscovery = function(start, change, cosigner, gap, cb) {
  var scanIndex = start;
  var lastActive = -1;
  var hasActivity = false;

  var self = this;
  async.doWhilst(
    function _do(next) {
    // Optimize window to minimize the derivations.
    var scanWindow = (lastActive == -1) ? gap : gap - (scanIndex - lastActive) + 1;
    var addresses = self.deriveAddresses(scanIndex, scanWindow, change, cosigner);
    self.blockchain.checkActivity(addresses, function(err, actives) {
      if (err) throw err;

      // Check for new activities in the newlly scanned addresses
      var recentActive = actives.reduce(function(r, e, i) {
        return e ? scanIndex + i : r;
      }, lastActive);
      hasActivity = lastActive != recentActive;
      lastActive = recentActive;
      scanIndex += scanWindow;
      next();
    });
  },
  function _while() {
    return hasActivity;
  },
  function _finnaly(err) {
    if (err) return cb(err);
    cb(null, lastActive);
  }
  );
}


Wallet.prototype.disconnect = function() {
  this.log('## DISCONNECTING');
  this.network.disconnect();
};

Wallet.prototype.getNetwork = function() {
  return this.network;
};

Wallet.prototype._checkAddressBook = function(key) {
  if (this.addressBook[key] && this.addressBook[key].copayerId != -1) {
    throw new Error('This address already exists in your Address Book: ' + address);
  }
};

Wallet.prototype.setAddressBook = function(key, label) {
  this._checkAddressBook(key);
  var copayerId = this.getMyCopayerId();
  var ts = Date.now();
  var payload = {
    address: key,
    label: label,
    copayerId: copayerId,
    createdTs: ts
  };
  var newEntry = {
    hidden: false,
    createdTs: ts,
    copayerId: copayerId,
    label: label,
    signature: this.signJson(payload)
  };
  this.addressBook[key] = newEntry;
  this.sendAddressBook();
  this.store();
};

Wallet.prototype.verifyAddressbookEntry = function(rcvEntry, senderId, key) {
  if (!key) throw new Error('Keys are required');
  var signature = rcvEntry.signature;
  var payload = {
    address: key,
    label: rcvEntry.label,
    copayerId: rcvEntry.copayerId,
    createdTs: rcvEntry.createdTs
  };
  return this.verifySignedJson(senderId, payload, signature);
}

Wallet.prototype.toggleAddressBookEntry = function(key) {
  if (!key) throw new Error('Key is required');
  this.addressBook[key].hidden = !this.addressBook[key].hidden;
  this.store();
};

Wallet.prototype.isShared = function() {
  return this.totalCopayers > 1;
}

Wallet.prototype.isReady = function() {
  var ret = this.publicKeyRing.isComplete() && this.publicKeyRing.isFullyBackup();
  return ret;
};

Wallet.prototype.setBackupReady = function() {
  this.publicKeyRing.setBackupReady();
  this.sendPublicKeyRing();
  this.store();
};

Wallet.prototype.signJson = function(payload) {
  var key = new bitcore.Key();
  key.private = new Buffer(this.getMyCopayerIdPriv(), 'hex');
  key.regenerateSync();
  var sign = bitcore.Message.sign(JSON.stringify(payload), key);
  return sign.toString('hex');
}

Wallet.prototype.verifySignedJson = function(senderId, payload, signature) {
  var pubkey = new Buffer(senderId, 'hex');
  var sign = new Buffer(signature, 'hex');
  var v = bitcore.Message.verifyWithPubKey(pubkey, JSON.stringify(payload), sign);
  return v;
}

module.exports = require('soop')(Wallet);