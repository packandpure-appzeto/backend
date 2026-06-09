import axios from "axios";

async function test() {
  try {
    // Admin login to get token
    const loginRes = await axios.post("http://localhost:5002/api/admin/login", {
      email: "admin@packandpure.com", // Assuming default admin email
      password: "password", // Assuming default admin password
    });
    
    console.log("Login success");
    const token = loginRes.data.token;
    
    // Test the API with a dummy ID
    const apiRes = await axios.get("http://localhost:5002/api/admin/delivery-partners/605c72a8c3d52c1f08a91a92", {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log("API response:", apiRes.data);
  } catch (error) {
    console.error("Error:", error.response ? error.response.data : error.message);
  }
}

test();
