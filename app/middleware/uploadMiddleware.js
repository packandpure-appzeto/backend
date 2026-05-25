import multer from "multer";

const storage = multer.memoryStorage();

const ALLOWED_MIME_PREFIXES = ["image/", "video/", "application/pdf"];
const ALLOWED_MIME_EXACT = [
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const mediaFileFilter = (req, file, cb) => {
    const ok =
        ALLOWED_MIME_PREFIXES.some((p) => file.mimetype.startsWith(p)) ||
        ALLOWED_MIME_EXACT.includes(file.mimetype);

    if (ok) {
        cb(null, true);
    } else {
        cb(
            new Error(
                "Unsupported file type. Allowed: images, videos, PDF, Word documents",
            ),
            false,
        );
    }
};

const createUpload = ({ maxFileSize, maxCount = 1 }) =>
    multer({
        storage,
        limits: { fileSize: maxFileSize, files: maxCount },
        fileFilter: mediaFileFilter,
    });

/** Single file — field name: `file` (max 15MB images/docs, 100MB video handled in controller) */
export const uploadSingleMedia = createUpload({
    maxFileSize: 100 * 1024 * 1024,
    maxCount: 1,
}).single("file");

/** Multiple files — field name: `files` (max 10) */
export const uploadMultipleMedia = createUpload({
    maxFileSize: 100 * 1024 * 1024,
    maxCount: 10,
}).array("files", 10);

/** Legacy image-only upload (5MB) — used by existing category/product routes */
const legacyUpload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith("image/")) {
            cb(null, true);
        } else {
            cb(new Error("Only images are allowed"), false);
        }
    },
});

export default legacyUpload;
