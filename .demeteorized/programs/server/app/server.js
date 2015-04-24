(function(){
if(Meteor.isServer)(
    Meteor.startup(function(){
        if(Articles.find().count()===0){
            Articles.insert({thumb:'shop.jpg',name:'dummy prashant',desc:'dummy 1',likes:0});
            Articles.insert({thumb:'button.png',name:'dummy button',desc:'dummy 2',likes:0});
            Articles.insert({thumb:'pin.png',name:'dummy pin',desc:'dummy 3',likes:0});
            //Articles.insert({thumb:'snnipest.jpg',name:'dummy snnipest',desc:'dummy 4'});
            //Articles.insert({thumb:'snnipest.jpg',name:'dummy snnipest',desc:'dummy 5'});
            //Articles.insert({thumb:'shop.jpg',name:'dummy prashant',desc:'dummy 1'});
            //Articles.insert({thumb:'button.png',name:'dummy button',desc:'dummy 2'});
            //Articles.insert({thumb:'pin.png',name:'dummy pin',desc:'dummy 3'});
            //Articles.insert({thumb:'snnipest.jpg',name:'dummy snnipest',desc:'dummy 4'});
            //Articles.insert({thumb:'snnipest.jpg',name:'dummy snnipest',desc:'dummy 5'});
            //Articles.insert({thumb:'shop.jpg',name:'dummy prashant',desc:'dummy 1'});
            //Articles.insert({thumb:'button.png',name:'dummy button',desc:'dummy 2'});
            //Articles.insert({thumb:'pin.png',name:'dummy pin',desc:'dummy 3'});
            //Articles.insert({thumb:'snnipest.jpg',name:'dummy snnipest',desc:'dummy 4'});
            //Articles.insert({thumb:'snnipest.jpg',name:'dummy snnipest',desc:'dummy 5'});
            //Articles.insert({thumb:'shop.jpg',name:'dummy prashant',desc:'dummy 1'});
            //Articles.insert({thumb:'button.png',name:'dummy button',desc:'dummy 2'});
            //Articles.insert({thumb:'pin.png',name:'dummy pin',desc:'dummy 3'});
            //Articles.insert({thumb:'snnipest.jpg',name:'dummy snnipest',desc:'dummy 4'});
            //Articles.insert({thumb:'snnipest.jpg',name:'dummy snnipest',desc:'dummy 5'});
            //Articles.insert({thumb:'shop.jpg',name:'dummy prashant',desc:'dummy 1'});
            //Articles.insert({thumb:'button.png',name:'dummy button',desc:'dummy 2'});
            //Articles.insert({thumb:'pin.png',name:'dummy pin',desc:'dummy 3'});
            //Articles.insert({thumb:'snnipest.jpg',name:'dummy snnipest',desc:'dummy 4'});
            //Articles.insert({thumb:'snnipest.jpg',name:'dummy snnipest',desc:'dummy 5'});
        }
        if(Products.find().count() === 0){
            Products.insert({thumb:'pin.png',name:'Apple Pie',desc:'Decadent Apple Pie',price:2.50,catName:'Fruity'});
            Products.insert({thumb:'button.png',name:'Blackberry Smoothie',desc:'Luscious Blackbery Smoothie',price:2.50,catName:'Fruity'});
            Products.insert({thumb:'shop.jpg',name:'EGO Twist',desc:'Ego Twist Mod',price:23.50,catName:'Mods'});

        }
        if(Categories.find().count() === 0){
            var hwid = Categories.insert({name:'HARDWARE'});
            var juid = Categories.insert({name:'JUICE'});
            SubCategories.insert({name:'Mods',cat:hwid});
            SubCategories.insert({name:'Fruity',cat:juid});
            SubCategories.insert({name:'Sweet',cat:juid});
        }


        Meteor.methods({
            addboards: function (name,description,url) {
                // Make sure the user is logged in before inserting a task

                Myboards.insert({
                    name: name,
                    description: description,
                    src: url
                });

            }
        });
        Meteor.publish("myboards",function(userid){
            return Myboards.find();
        })

        Meteor.publish("likes",function(postid){
            return Likes.find({post:postid});
        })
        Meteor.publish("articles",function(){
            return Articles.find();
        })
        Meteor.publish("categories",function(){
            return Categories.find();
        })
        Meteor.publish("products",function(){
            return Products.find();
        })
        Meteor.publish("subcategories",function(){
            return SubCategories.find();
        })

    })

)

})();
