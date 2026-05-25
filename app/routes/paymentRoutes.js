import express from "express";
import { createRazorpayOrder, verifyPayment } from "../controller/paymentController.js";
import { verifyToken, allowRoles } from "../middleware/authMiddleware.js";

const router = express.Router();

const customerOnly = [verifyToken, allowRoles("customer")];
router.post("/create-order", ...customerOnly, createRazorpayOrder);
router.post("/verify", ...customerOnly, verifyPayment);

export default router;
