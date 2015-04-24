(function(){if(Meteor.isClient) {
//   myposts helpers

    Template.myposts.helpers({

        shareename: function () {
            var shareename = Meteor.usersId();
            return shareename;
        },
        name: this.name,
        desc: this.description,
        src: this.src,
        likeCount: function () {
            return 0;
        },

        username: function () {
            return Meteor.user() && Meteor.user().username;
        }


    });


    // myposts events
    Template.myposts.events({
        'click .likebtn' : function(evt,tmpl){
            Likes.insert();

        }

    });
}


})();
