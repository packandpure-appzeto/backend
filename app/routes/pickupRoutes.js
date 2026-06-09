import express from "express";
import { verifyToken, allowRoles } from "../middleware/authMiddleware.js";
import {
  getMyPickupAssignments,
  markAssignmentPicked,
  markAssignmentHubDelivered,
} from "../controller/pickupPartnerController.js";

const router = express.Router();

router.get(
  "/tasks",
  verifyToken,
  allowRoles("pickup_partner", "delivery"),
  getMyPickupAssignments,
);
router.post(
  "/confirm-pickup/:id",
  verifyToken,
  allowRoles("pickup_partner", "delivery"),
  markAssignmentPicked,
);
router.post(
  "/deliver-to-hub/:id",
  verifyToken,
  allowRoles("pickup_partner", "delivery"),
  markAssignmentHubDelivered,
);

export default router;
