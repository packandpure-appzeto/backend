import express from "express";
import {
    getProducts,
    getSellerProducts,
    createProduct,
    updateProduct,
    updateVariantStock,
    deleteProduct,
    getProductById,
    getSellerProductGoLivePreview,
    publishSellerProductGoLive,
} from "../controller/productController.js";
import { adjustStock, getStockHistory } from "../controller/stockController.js";
import { verifyToken, allowRoles, isAccountVerified } from "../middleware/authMiddleware.js";
import upload from "../middleware/uploadMiddleware.js";

const router = express.Router();

// Admin protected listing (bypass customer lat/lng visibility constraint)
router.get("/admin/list", verifyToken, allowRoles("admin"), getProducts);

// Public routes
router.get("/", getProducts);

// Seller protected routes
router.get("/seller/me", verifyToken, allowRoles("seller"), getSellerProducts);

// Variant-aware stock (must be before /:id)
router.patch(
    "/:id/variant-stock",
    verifyToken,
    allowRoles("seller", "admin"),
    updateVariantStock
);
router.post(
    "/:id/variant-stock",
    verifyToken,
    allowRoles("seller", "admin"),
    updateVariantStock
);

router.get(
    "/:id/go-live-preview",
    verifyToken,
    allowRoles("admin"),
    getSellerProductGoLivePreview,
);
router.post(
    "/:id/go-live",
    verifyToken,
    allowRoles("admin"),
    publishSellerProductGoLive,
);

router.get("/:id", getProductById);

router.post(
    "/",
    verifyToken,
    allowRoles("seller", "admin"),
    upload.fields([
        { name: 'mainImage', maxCount: 1 },
        { name: 'galleryImages', maxCount: 5 }
    ]),
    createProduct
);

router.put(
    "/:id",
    verifyToken,
    allowRoles("seller", "admin"),
    upload.fields([
        { name: 'mainImage', maxCount: 1 },
        { name: 'galleryImages', maxCount: 5 },
        { name: 'images', maxCount: 5 } // For admin compatibility
    ]),
    updateProduct
);

router.delete(
    "/:id",
    verifyToken,
    allowRoles("seller", "admin"),
    deleteProduct
);

// Stock Management
router.post("/adjust-stock", verifyToken, allowRoles("seller"), isAccountVerified, adjustStock);
router.get("/stock-history", verifyToken, allowRoles("seller"), isAccountVerified, getStockHistory);

export default router;
