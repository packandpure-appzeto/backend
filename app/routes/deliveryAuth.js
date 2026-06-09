import express from "express";
import {
  signupDelivery,
  loginDelivery,
  verifyDeliveryOTP,
  getDeliveryProfile,
  updateDeliveryProfile,
  logoutDelivery,
} from "../controller/deliveryAuthController.js";
import {
  getDeliveryStats,
  getDeliveryEarnings,
  getMyDeliveryOrders,
  requestWithdrawal,
  updateDeliveryLocation,
  generateDeliveryOtp,
  validateDeliveryOtp,
} from "../controller/deliveryController.js";
import {
  getAvailableOrders,
  acceptOrder,
  updateOrderStatus,
} from "../controller/orderController.js";

import {
  verifyToken,
  allowRoles,
  isAccountVerified,
} from "../middleware/authMiddleware.js";
import upload from "../middleware/uploadMiddleware.js";

const router = express.Router();
const deliveryOnly = [verifyToken, allowRoles("delivery")];
const deliveryOps = [...deliveryOnly, isAccountVerified];

router.post(
  "/send-signup-otp",
  upload.fields([
    { name: "aadhar", maxCount: 1 },
    { name: "pan", maxCount: 1 },
    { name: "dl", maxCount: 1 },
  ]),
  signupDelivery,
);
router.post("/send-login-otp", loginDelivery);
router.post("/verify-otp", verifyDeliveryOTP);
router.post("/logout", ...deliveryOnly, logoutDelivery);

router.get("/profile", ...deliveryOnly, getDeliveryProfile);
router.put("/profile", ...deliveryOnly, updateDeliveryProfile);
router.get("/stats", ...deliveryOnly, getDeliveryStats);
router.get("/earnings", ...deliveryOnly, getDeliveryEarnings);
router.get("/order-history", ...deliveryOnly, getMyDeliveryOrders);
router.get("/tasks", ...deliveryOps, getAvailableOrders);
router.post("/pickup", ...deliveryOps, (req, res) => {
  if (!req.body?.orderId) {
    return res.status(400).json({ message: "orderId is required" });
  }
  req.params.orderId = req.body.orderId;
  return acceptOrder(req, res);
});
router.post("/complete", ...deliveryOps, (req, res) => {
  if (!req.body?.orderId) {
    return res.status(400).json({ message: "orderId is required" });
  }
  req.params.orderId = req.body.orderId;
  req.body.status = "delivered";
  return updateOrderStatus(req, res);
});
router.post("/request-withdrawal", ...deliveryOnly, requestWithdrawal);
router.post("/location", ...deliveryOps, updateDeliveryLocation);
router.post(
  "/orders/:orderId/generate-otp",
  ...deliveryOps,
  generateDeliveryOtp,
);
router.post(
  "/orders/:orderId/validate-otp",
  ...deliveryOps,
  validateDeliveryOtp,
);

export default router;
