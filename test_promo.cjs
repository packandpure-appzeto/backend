const mongoose = require('mongoose');

mongoose.connect('mongodb+srv://devpot076_db_user:YIrtY0KIkVV89TP8@cluster0.yajfcg3.mongodb.net/grhapoch', { useNewUrlParser: true, useUnifiedTopology: true })
.then(async () => {
    await mongoose.connection.db.collection('promotions').updateOne({ code: 'FIRTUSER10' }, { $set: { validTill: new Date('2026-12-31T00:00:00Z') } });
    const promos = await mongoose.connection.db.collection('promotions').find().toArray();
    console.log("Updated Promos:", JSON.stringify(promos, null, 2));

    const Customer = mongoose.connection.db.collection('users');
    const firstCustomer = await Customer.findOne({ role: 'customer' });
    console.log("First Customer ID:", firstCustomer._id);
    
    // Now make a request to the local API
    const axios = require('axios');
    try {
        const res = await axios.get(`http://localhost:5002/api/promotions/available?customerId=${firstCustomer._id}`);
        console.log("Eligible Promos:", res.data);
    } catch (err) {
        console.error(err);
    }
})
.finally(() => process.exit(0));
