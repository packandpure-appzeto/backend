import axios from "axios";

async function test() {
  try {
    // Generate an OTP and login first to get a token, or just mock it.
    // Let's use the DB directly instead. But wait, we want to test the API endpoint!
    // I can just query the DB for the recent delivery boy to get their ID, generate a token, and call the API.
    
    // First let's get the token
    const mongoose = (await import("mongoose")).default;
    const jwt = (await import("jsonwebtoken")).default;
    const dotenv = (await import("dotenv")).default;
    dotenv.config();

    await mongoose.connect(process.env.MONGO_URI);
    const Delivery = (await import("./app/models/delivery.js")).default;
    
    // Use the ID from the image: 6a2413e08b6cc2977c0db81a
    // Wait, the image says 6a2413e08b6cc2977c0db81a
    const delivery = await Delivery.findOne();
    if (!delivery) {
       console.log("No delivery found");
       process.exit();
    }
    
    const token = jwt.sign(
        { id: delivery._id, role: "delivery" },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
    );
    
    console.log("Token generated:", token);
    
    const response = await axios.post("http://localhost:5002/api/delivery/logout", {}, {
       headers: {
           Authorization: `Bearer ${token}`
       }
    });
    
    console.log("Response:", response.data);
    process.exit(0);
  } catch (error) {
    console.error("Error:", error.response ? error.response.data : error.message);
    process.exit(1);
  }
}

test();
