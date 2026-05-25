import express from "express";
import { verifyToken, allowRoles } from "../middleware/authMiddleware.js";
import {
  getSellerPurchaseRequests,
  respondSellerPurchaseRequest,
  markSellerRequestReady,
} from "../controller/purchaseRequestController.js";

const router = express.Router();

router.get("/orders", verifyToken, allowRoles("seller"), getSellerPurchaseRequests);
router.post("/accept-order/:id", verifyToken, allowRoles("seller"), (req, res) => {
  req.body = { ...(req.body || {}), action: "accept" };
  return respondSellerPurchaseRequest(req, res);
});
router.post(
  "/mark-ready/:id",
  verifyToken,
  allowRoles("seller"),
  markSellerRequestReady,
);

export default router;
