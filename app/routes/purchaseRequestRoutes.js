import express from "express";
import { verifyToken, allowRoles } from "../middleware/authMiddleware.js";
import {
  getPurchaseRequests,
  createManualPurchaseRequest,
  updatePurchaseRequestStatus,
  assignPickupPartner,
  assignVendor,
  receiveAtHub,
  verifyInward,
} from "../controller/purchaseRequestController.js";

const router = express.Router();

router.get("/", verifyToken, allowRoles("admin"), getPurchaseRequests);
router.post("/", verifyToken, allowRoles("admin"), createManualPurchaseRequest);
router.put("/:id/status", verifyToken, allowRoles("admin"), updatePurchaseRequestStatus);
router.put(
  "/:id/assign-vendor",
  verifyToken,
  allowRoles("admin"),
  assignVendor,
);
router.put(
  "/:id/assign-pickup",
  verifyToken,
  allowRoles("admin"),
  assignPickupPartner,
);
router.post("/:id/receive", verifyToken, allowRoles("admin"), receiveAtHub);
router.post("/:id/verify", verifyToken, allowRoles("admin"), verifyInward);

export default router;
