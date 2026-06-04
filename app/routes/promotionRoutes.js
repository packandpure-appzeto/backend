import express from "express";
import {
    listPromotions,
    createPromotion,
    getPromotion,
    updatePromotion,
    updateStatus,
    deletePromotion,
    getAnalytics,
    getAvailablePromotions,
    validatePromotion
} from "../controller/promotionController.js";

const router = express.Router();

// Admin Routes
router.get("/admin/promotions", listPromotions);
router.post("/admin/promotions", createPromotion);
router.get("/admin/promotions/:id", getPromotion);
router.put("/admin/promotions/:id", updatePromotion);
router.patch("/admin/promotions/:id/status", updateStatus);
router.delete("/admin/promotions/:id", deletePromotion);
router.get("/admin/promotions/:id/analytics", getAnalytics);

// Customer Routes
router.get("/promotions/available", getAvailablePromotions);
router.post("/promotions/validate", validatePromotion);

export default router;
