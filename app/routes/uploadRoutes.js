import express from "express";
import {
    uploadSingle,
    uploadMultiple,
    listUploadFolders,
} from "../controller/uploadController.js";
import {
    uploadSingleMedia,
    uploadMultipleMedia,
} from "../middleware/uploadMiddleware.js";
import { verifyToken } from "../middleware/authMiddleware.js";

const router = express.Router();

const handleMulterError = (err, req, res, next) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
            success: false,
            error: true,
            message: "File too large",
            result: {},
        });
    }
    return res.status(400).json({
        success: false,
        error: true,
        message: err.message || "Upload failed",
        result: {},
    });
};

router.use(verifyToken);

router.get("/folders", listUploadFolders);

router.post(
    "/single",
    (req, res, next) => {
        uploadSingleMedia(req, res, (err) => {
            if (err) return handleMulterError(err, req, res, next);
            next();
        });
    },
    uploadSingle,
);

router.post(
    "/multiple",
    (req, res, next) => {
        uploadMultipleMedia(req, res, (err) => {
            if (err) return handleMulterError(err, req, res, next);
            next();
        });
    },
    uploadMultiple,
);

export default router;
