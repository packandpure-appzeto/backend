import express from "express";
import {
    signupAdmin,
    loginAdmin,
    forgotPasswordOtp,
    resetPasswordWithOtp
} from "../controller/adminAuthController.js";
import {
    getAdminProfile,
    updateAdminProfile,
    updateAdminPassword,
    getAdminStats,
    getDeliveryPartners,
    getDeliveryPartnerById,
    approveDeliveryPartner,
    rejectDeliveryPartner,
    getActiveFleet,
    getAdminWalletData,
    getDeliveryTransactions,
    settleTransaction,
    bulkSettleDelivery,
    getSellerWithdrawals,
    getDeliveryWithdrawals,
    getPickupWithdrawals,
    updateWithdrawalStatus,
    settlePickupPartnerWallet,
    getSellerTransactions,
    getDeliveryCashBalances,
    getRiderCashDetails,
    settleRiderCash,
    getCashSettlementHistory,
    getUsers,
    getUserById,
    getSellers,
    createSellerByAdmin,
    updateSellerByAdmin,
    getPlatformSettings,
    updatePlatformSettings,
    getCodCustomers,
    updateCustomerCodPolicy,
    updateCustomerAccountStatus,
    approveSeller,
    rejectSeller,
    getSellerById,
    getReports
} from "../controller/adminController.js";


import { verifyToken, allowRoles } from "../middleware/authMiddleware.js";

const router = express.Router();

// Signup removed for security - admins must be created directly in DB
// router.post("/signup", signupAdmin);
router.post("/login", loginAdmin);
router.post("/forgot-password", forgotPasswordOtp);
router.post("/reset-password", resetPasswordWithOtp);

// Profile routes
router.get(
    "/profile",
    verifyToken,
    allowRoles("admin"),
    getAdminProfile
);

router.put(
    "/profile",
    verifyToken,
    allowRoles("admin"),
    updateAdminProfile
);

router.put(
    "/profile/password",
    verifyToken,
    allowRoles("admin"),
    updateAdminPassword
);

router.get(
    "/stats",
    verifyToken,
    allowRoles("admin"),
    getAdminStats
);
router.get(
    "/settings/platform",
    verifyToken,
    allowRoles("admin"),
    getPlatformSettings
);
router.put(
    "/settings/platform",
    verifyToken,
    allowRoles("admin"),
    updatePlatformSettings
);
router.get("/users", verifyToken, allowRoles("admin"), getUsers);
router.get("/users/:id", verifyToken, allowRoles("admin"), getUserById);
router.get("/users-cod", verifyToken, allowRoles("admin"), getCodCustomers);
router.patch("/users/:id/cod-policy", verifyToken, allowRoles("admin"), updateCustomerCodPolicy);
router.patch("/users/:id/status", verifyToken, allowRoles("admin"), updateCustomerAccountStatus);
router.get("/sellers", verifyToken, allowRoles("admin"), getSellers);
router.get("/sellers/:id", verifyToken, allowRoles("admin"), getSellerById);
router.post("/sellers", verifyToken, allowRoles("admin"), createSellerByAdmin);
router.put("/sellers/:id", verifyToken, allowRoles("admin"), updateSellerByAdmin);
router.patch("/sellers/approve/:id", verifyToken, allowRoles("admin"), approveSeller);
router.delete("/sellers/reject/:id", verifyToken, allowRoles("admin"), rejectSeller);


router.get(
    "/delivery-partners",
    verifyToken,
    allowRoles("admin"),
    getDeliveryPartners
);

router.get(
    "/delivery-partners/:id",
    verifyToken,
    allowRoles("admin"),
    getDeliveryPartnerById
);

router.patch(
    "/delivery-partners/approve/:id",
    verifyToken,
    allowRoles("admin"),
    approveDeliveryPartner
);

router.delete(
    "/delivery-partners/reject/:id",
    verifyToken,
    allowRoles("admin"),
    rejectDeliveryPartner
);

router.get("/active-fleet", verifyToken, allowRoles("admin"), getActiveFleet);
router.get("/wallet-data", verifyToken, allowRoles("admin"), getAdminWalletData);

// Delivery Payouts / Funds
router.get("/delivery-transactions", verifyToken, allowRoles('admin'), getDeliveryTransactions);
router.put("/transactions/:id/settle", verifyToken, allowRoles("admin"), settleTransaction);
router.put("/transactions/bulk-settle-delivery", verifyToken, allowRoles("admin"), bulkSettleDelivery);

// Cash Collection Hub
router.get("/delivery-cash", verifyToken, allowRoles("admin"), getDeliveryCashBalances);
router.get("/rider-cash-details/:id", verifyToken, allowRoles("admin"), getRiderCashDetails);
router.post("/settle-cash", verifyToken, allowRoles("admin"), settleRiderCash);
router.get("/cash-history", verifyToken, allowRoles("admin"), getCashSettlementHistory);
router.get("/reports", verifyToken, allowRoles("admin"), getReports);

// Seller Withdrawal Management
router.get("/seller-withdrawals", verifyToken, allowRoles("admin"), getSellerWithdrawals);
router.get("/delivery-withdrawals", verifyToken, allowRoles("admin"), getDeliveryWithdrawals);
router.get("/pickup-withdrawals", verifyToken, allowRoles("admin"), getPickupWithdrawals);
router.post("/settle-pickup-wallet", verifyToken, allowRoles("admin"), settlePickupPartnerWallet);
router.get("/seller-transactions", verifyToken, allowRoles("admin"), getSellerTransactions);
router.put("/withdrawals/:id", verifyToken, allowRoles("admin"), updateWithdrawalStatus);

// Protected admin route example
router.get(
    "/dashboard",
    verifyToken,
    allowRoles("admin"),
    (req, res) => {
        res.json({
            success: true,
            message: "Welcome to Admin Dashboard",
        });
    }
);

export default router;
