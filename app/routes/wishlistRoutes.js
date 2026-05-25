import express from "express";
import {
    getWishlist,
    addToWishlist,
    removeFromWishlist,
    toggleWishlist
} from "../controller/wishlistController.js";
import { verifyToken, allowRoles } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(verifyToken, allowRoles("customer"));

router.get("/", getWishlist);
router.post("/add", addToWishlist);
router.post("/toggle", toggleWishlist);
router.delete("/remove/:productId", removeFromWishlist);

export default router;
