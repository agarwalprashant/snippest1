(function(){

Articles= new Meteor.Collection('articles');
Likes = new Meteor.Collection('likes');
Myboards= new Meteor.Collection('myboards');
Categories = new Mongo.Collection('categories');
SubCategories = new Mongo.Collection('subcategories');
Products = new Mongo.Collection('products');
Customer = new Mongo.Collection('customers');
Cart = new Mongo.Collection('cart');
CartItems  = new Mongo.Collection('cartitems');

})();
