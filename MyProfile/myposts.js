if(Meteor.isClient) {
//   myposts helpers

    Template.myposts.helpers({


        name: this.name,
        desc: this.description,
        src: this.src,


        username: function () {
            return Meteor.user() && Meteor.user().username;
        }


    });


    // myposts events
    Template.myposts.events({
        'click .like' :  function(articleid){
            var articleid = this._id;
            var article= Myboards.findOne(articleid);
            Myboards.update(
                articleid,
                {$set: {likes: article.likes + 1}}
            );
        }

    });
}

