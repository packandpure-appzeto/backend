import mongoose from "mongoose";

mongoose.connect('mongodb+srv://devpot076_db_user:YIrtY0KIkVV89TP8@cluster0.yajfcg3.mongodb.net/grhapoch')
  .then(() => mongoose.connection.db.collection('promotions').updateOne({code: 'FIRTUSER10'}, { $set: {'conditions.maxOrderValue': null} }))
  .then(r => {
    console.log(r);
    process.exit(0);
  });
