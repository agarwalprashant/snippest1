(function(){if (Meteor.isClient) {
//   friends helpers

    Template.friends.helpers({

        myboards1: function () {
            return Myboards.find({});

        }

    });
}

})();
