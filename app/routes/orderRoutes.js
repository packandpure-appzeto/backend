import express from "express";
import {
  placeOrder,
  getMyOrders,
  getOrderDetails,
  cancelOrder,
  updateOrderStatus,
  getSellerOrders,
  getAvailableOrders,
  acceptOrder,
  skipOrder,
  requestReturn,
  getReturnDetails,
  getSellerReturns,
  approveReturnRequest,
  rejectReturnRequest,
  assignReturnDelivery,
  updateReturnStatus,
  getDeliveryFee,
} from "../controller/orderController.js";
import {
  confirmPickup,
  markArrivedAtStore,
  advanceDeliveryRiderUi,
  requestDeliveryOtp,
  verifyDeliveryOtp,
  getOrderRoute,
} from "../controller/orderWorkflowController.js";
// Assuming there's a middleware to verify customer token
import { verifyToken, allowRoles, isAccountVerified } from "../middleware/authMiddleware.js";

const router = express.Router();

// Customer routes
const customerOnly = [verifyToken, allowRoles("customer")];
router.post("/place", ...customerOnly, placeOrder);
router.post("/create", ...customerOnly, placeOrder);
router.get("/my-orders", ...customerOnly, getMyOrders);
router.get(
  "/details/:orderId",
  verifyToken,
  allowRoles("customer", "user", "admin", "seller", "delivery"),
  getOrderDetails,
);
router.put("/cancel/:orderId", ...customerOnly, cancelOrder);
router.post("/:orderId/returns", ...customerOnly, requestReturn);
router.get("/:orderId/returns", ...customerOnly, getReturnDetails);
router.get("/calculate-delivery-fee", ...customerOnly, getDeliveryFee);

// Admin/Seller routes (might need different auth middleware for role checks)

router.get(
  "/seller-orders",
  verifyToken,
  allowRoles("admin", "seller"),
  getSellerOrders,
);
router.put(
  "/status/:orderId",
  verifyToken,
  allowRoles("admin", "seller", "delivery"),
  updateOrderStatus,
);
router.get(
  "/seller-returns",
  verifyToken,
  allowRoles("admin", "seller"),
  getSellerReturns,
);
router.put(
  "/returns/:orderId/approve",
  verifyToken,
  allowRoles("admin", "seller"),
  approveReturnRequest,
);
router.put(
  "/returns/:orderId/reject",
  verifyToken,
  allowRoles("admin", "seller"),
  rejectReturnRequest,
);
router.put(
  "/returns/:orderId/assign-delivery",
  verifyToken,
  allowRoles("admin", "seller"),
  assignReturnDelivery,
);

// Delivery routes
router.get(
  "/available",
  verifyToken,
  allowRoles("admin", "delivery"),
  isAccountVerified,
  getAvailableOrders,
);
router.put(
  "/accept/:orderId",
  verifyToken,
  allowRoles("admin", "delivery"),
  isAccountVerified,
  acceptOrder,
);
router.put(
  "/skip/:orderId",
  verifyToken,
  allowRoles("admin", "delivery"),
  isAccountVerified,
  skipOrder,
);
router.put(
  "/return-status/:orderId",
  verifyToken,
  allowRoles("admin", "delivery"),
  isAccountVerified,
  updateReturnStatus,
);

router.post(
  "/workflow/:orderId/pickup/confirm",
  verifyToken,
  allowRoles("delivery", "admin"),
  isAccountVerified,
  confirmPickup,
);
router.post(
  "/workflow/:orderId/pickup/ready",
  verifyToken,
  allowRoles("delivery", "admin"),
  isAccountVerified,
  markArrivedAtStore,
);
router.post(
  "/workflow/:orderId/rider/advance-ui",
  verifyToken,
  allowRoles("delivery", "admin"),
  isAccountVerified,
  advanceDeliveryRiderUi,
);
router.post(
  "/workflow/:orderId/otp/request",
  verifyToken,
  allowRoles("delivery", "admin"),
  isAccountVerified,
  requestDeliveryOtp,
);
router.post(
  "/workflow/:orderId/otp/verify",
  verifyToken,
  allowRoles("delivery", "admin"),
  isAccountVerified,
  verifyDeliveryOtp,
);
router.get(
  "/workflow/:orderId/route",
  verifyToken,
  allowRoles("customer", "user", "delivery", "seller", "admin"),
  getOrderRoute,
);

export default router;
