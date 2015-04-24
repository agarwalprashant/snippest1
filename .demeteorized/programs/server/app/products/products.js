(function(){if (Meteor.isClient) {
Meteor.subscribe("products");

    Session.setDefault('category', null);

    Template.products.helpers({
        'productlist': function () {
            return Products.find({catName: Session.get('category')});
        },
        'catnotselected': function () {
            return Session.equals('category', null);
        },
        'category': function () {
            return Session.get('category');
        }
    });

    Template.product.events({
        'click .addcart':function(evt,tmpl){
            var qty = tmpl.find('.prodqty').value;
            var product = this._id;
            var sessid = Meteor.default_connection._lastSessionId;
            Meteor.call('addToCart',qty,product,sessid);
        }
    });

    Meteor.methods({

        addToCart:function(qty,product,session){
            if(qty > 0){
                CartItems.insert({qty:qty,product:product,sessid:session});
            } else{
                console.log('Quantity is Zero');
            }

        }
    });
}

})();
