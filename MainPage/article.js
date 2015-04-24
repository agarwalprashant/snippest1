if(Meteor.isClient) {
//Meteor.methods({
//    upvote : function(articleid){
//        var article= Articles.findOne(articleid);
//        Articles.update(
//            articleid,
//            {$set: {votes: article.votes + 1}}
//        );
//    },
//    downvote : function(articleid){
//        var article= Articles.findOne(articleid);
//        Articles.update(
//            articleid,
//            {$set:{votes: article.votes - 1}}
//        );
//    }
//
//});
//
//    Template.article.helpers({
//        'numlikes': function () {
//            return Likes.find({article: this._id}).count()
//        },
//        'likesthis': function () {
//            var doeslike = Likes.findOne({muser: Meteor.userId(), article: this._id});
//            if (doeslike)
//                return "you like this";
//        }
//    })


    Template.article.events({

            'click .like' : function(articleid){
                var articleid = this._id;
                var article= Articles.findOne(articleid);
                Articles.update(
                    articleid,
                    {$set: {likes: article.likes + 1}}
                );
            },
            'click .unlike' : function(articleid){
                var articleid = this._id;
                var article= Articles.findOne(articleid);
                Articles.update(
                    articleid,
                    {$set:{likes: article.likes - 1}}
                );
            }
        }
    );
}