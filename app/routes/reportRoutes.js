import express from "express";
import {
    exportGstReport,
    exportVendorPayoutsReport,
    exportInventoryReport
} from "../controller/reportController.js";
import { verifyToken, allowRoles } from "../middleware/authMiddleware.js";

const router = express.Router();

// All report routes are admin-only
router.use(verifyToken);
router.use(allowRoles("admin"));

router.get("/gst-export", exportGstReport);
router.get("/vendor-payouts-export", exportVendorPayoutsReport);
router.get("/inventory-export", exportInventoryReport);

export default router;
