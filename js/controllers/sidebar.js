'use strict';

angular.module('copayApp.controllers').controller('SidebarController', 
    function($scope, $rootScope, $sce, $location, $http, notification, controllerUtils) {

    $scope.menu = [{
      'title': 'Receive',
      'icon': 'fi-arrow-left',
      'link': 'receive'
    }, {
      'title': 'Send',
      'icon': 'fi-arrow-right',
      'link': 'send'
    }, {
      'title': 'History',
      'icon': 'fi-clipboard-pencil',
      'link': 'history'
    }, {
      'title': 'More',
      'icon': 'fi-download',
      'link': 'backup'
    }];

    $scope.signout = function() {
      logout();
    };

    // Ensures a graceful disconnect
    window.onbeforeunload = logout;

    $scope.$on('$destroy', function() {
      window.onbeforeunload = undefined;
    });


    $scope.refresh = function() {
      var w = $rootScope.wallet;
      w.connectToAll();
      if ($rootScope.addrInfos.length > 0) {
        controllerUtils.updateBalance(function() {
          $rootScope.$digest();
        });
      }
    };

    $scope.isActive = function(item) {
      return item.link && item.link == $location.path().split('/')[1];
    };

    function logout() {
      var w = $rootScope.wallet;
      if (w) {
        w.disconnect();
        controllerUtils.logout();
      }
    }

    // ng-repeat defined number of times instead of repeating over array?
    $scope.getNumber = function(num) {
      return new Array(num);
    }

    // Init socket handlers (with no wallet yet)
    controllerUtils.setSocketHandlers();

    if ($rootScope.wallet) {
      $scope.$on('$idleStart', function(a) {
        notification.warning('Session will be closed', 'Your session is about to expire due to inactivity');
      });

      $scope.$on('$idleTimeout', function() {
        $scope.signout();
        notification.warning('Session closed', 'Session closed because a long time of inactivity');
      });
    }

  });