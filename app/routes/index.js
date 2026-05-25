import customerRoute from "./customerAuth.js";
import deliveryRoute from "./deliveryAuth.js";
import adminRoute from "./adminAuth.js";
import sellerRoute from "./sellerAuth.js";
import vendorRoute from "./vendorRoutes.js";
import categoryRoute from "./categoryRoutes.js";
import productRoute from "./productRoutes.js";
import cartRoute from "./cartRoutes.js";
import wishlistRoute from "./wishlistRoutes.js";
import orderRoute from "./orderRoutes.js";
import paymentRoute from "./paymentRoutes.js";
import notificationRoute from "./notificationRoutes.js";
import ticketRoute from "./ticketRoutes.js";
import reviewRoute from "./reviewRoutes.js";
import faqRoute from "./faqRoutes.js";
import experienceRoute from "./experienceRoutes.js";
import offerRoute from "./offerRoutes.js";
import couponRoute from "./couponRoutes.js";
import settingsRoute from "./settingsRoutes.js";
import hubInventoryRoute from "./hubInventoryRoutes.js";
import purchaseRequestRoute from "./purchaseRequestRoutes.js";
import pickupPartnerRoute from "./pickupPartnerRoutes.js";
import pickupRoute from "./pickupRoutes.js";
import reportRoute from "./reportRoutes.js";
import uploadRoute from "./uploadRoutes.js";

import express from "express";

const setupRoutes = (app) => {
    const router = express.Router();

    router.use("/upload", uploadRoute);
    router.use("/customer", customerRoute);
    router.use("/delivery", deliveryRoute);
    router.use("/admin/categories", categoryRoute);
    router.use("/admin", adminRoute);
    router.use("/seller", sellerRoute);
    // Legacy alias — same seller procurement handlers; prefer /api/seller
    router.use("/vendor", vendorRoute);
    router.use("/settings", settingsRoute);
    router.use("/admin/hub-inventory", hubInventoryRoute);
    router.use("/admin/purchase-requests", purchaseRequestRoute);
    router.use("/admin/pickup-partners", pickupPartnerRoute);
    router.use("/pickup-partner", pickupPartnerRoute);
    router.use("/admin/reports", reportRoute);
    router.use("/pickup", pickupRoute);
    router.use("/categories", categoryRoute);
    router.use("/products", productRoute);
    router.use("/cart", cartRoute);
    router.use("/wishlist", wishlistRoute);
    router.use("/orders", orderRoute);
    router.use("/payments", paymentRoute);
    router.use("/", experienceRoute);
    router.use("/", offerRoute);
    router.use("/", couponRoute);
    router.use("/notifications", notificationRoute);
    router.use("/tickets", ticketRoute);
    router.use("/reviews", reviewRoute);
    router.use("/admin/faqs", faqRoute);
    router.use("/public/faqs", faqRoute); // For public access without admin prefix

    app.use("/api", router);
}
export default setupRoutes;
