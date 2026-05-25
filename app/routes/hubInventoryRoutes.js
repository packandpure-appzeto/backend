import express from "express";
import { verifyToken, allowRoles } from "../middleware/authMiddleware.js";
import {
  getHubInventory,
  upsertHubInventory,
  adjustHubInventoryStock,
  updateHubInventoryReorderLevel,
} from "../controller/hubInventoryController.js";

const router = express.Router();

router.get("/", verifyToken, allowRoles("admin"), getHubInventory);
router.post("/upsert", verifyToken, allowRoles("admin"), upsertHubInventory);
router.post(
  "/:id/adjust-stock",
  verifyToken,
  allowRoles("admin"),
  adjustHubInventoryStock,
);
router.put(
  "/:id/reorder-level",
  verifyToken,
  allowRoles("admin"),
  updateHubInventoryReorderLevel,
);

export default router;
