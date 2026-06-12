import express from "express";
import {
    createProductRequest,
    getCustomerProductRequests,
    getAllProductRequests,
    updateProductRequestStatus
} from "../controller/productRequestController.js";
import { verifyToken, allowRoles } from "../middleware/authMiddleware.js";

const router = express.Router();

// Customer routes
router.post("/", verifyToken, allowRoles("customer"), createProductRequest);
router.get("/my-requests", verifyToken, allowRoles("customer"), getCustomerProductRequests);

// Admin routes
router.get("/", verifyToken, allowRoles("admin", "superadmin"), getAllProductRequests);
router.put("/:id/status", verifyToken, allowRoles("admin", "superadmin"), updateProductRequestStatus);

export default router;
