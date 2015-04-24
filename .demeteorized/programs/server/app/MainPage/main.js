(function(){if(Meteor.isClient) {
Meteor.subscribe("articles");
       Template.main.helpers({
        articles: function () {
            //finding just first 20 articles in articles collection
            var search = {};
            return Articles.find({},{sort:{likes: -1}});
        }
    });


}

})();
