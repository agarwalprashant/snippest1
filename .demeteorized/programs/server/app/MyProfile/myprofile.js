(function(){if (Meteor.isClient) {

    Meteor.subscribe("myboards",Meteor.userId());


    Template.myprofile.events({
        'click .addInterest': function () {
            Session.set("form", true);
        }


    });

// myprofile helpers

    Template.myprofile.helpers({
        'adding_interest': function () {
            return Session.get("form");
        },
        myboards1: function () {
            return Myboards.find({});

        },
        username: function () {
            return Meteor.user() && Meteor.user().username;
        }

    });

}

})();
