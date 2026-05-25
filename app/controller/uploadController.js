import handleResponse from "../utils/helper.js";
import {
    uploadBufferToCloudinary,
    ALLOWED_MEDIA_FOLDERS,
    CLOUDINARY_ROOT,
} from "../utils/cloudinary.js";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_DOC_BYTES = 20 * 1024 * 1024;

const resolveFolder = (req) =>
    req.body?.folder ?? req.query?.folder ?? "misc";

const validateFileSize = (file) => {
    if (!file?.buffer?.length) {
        return "File is empty or missing";
    }
    const { mimetype, size } = file;
    if (mimetype.startsWith("image/") && size > MAX_IMAGE_BYTES) {
        return "Image must be 15MB or smaller";
    }
    if (mimetype.startsWith("video/") && size > MAX_VIDEO_BYTES) {
        return "Video must be 100MB or smaller";
    }
    if (
        (mimetype === "application/pdf" ||
            mimetype.includes("wordprocessingml") ||
            mimetype === "application/msword") &&
        size > MAX_DOC_BYTES
    ) {
        return "Document must be 20MB or smaller";
    }
    return null;
};

const uploadOneFile = async (file, folder) => {
    const sizeError = validateFileSize(file);
    if (sizeError) {
        const err = new Error(sizeError);
        err.statusCode = 400;
        throw err;
    }

    return uploadBufferToCloudinary(file.buffer, {
        folder,
        mimetype: file.mimetype,
    });
};

/**
 * POST /api/upload/single
 * multipart: file
 * body/query: folder (e.g. products, customers/avatars)
 */
export const uploadSingle = async (req, res) => {
    try {
        if (!req.file) {
            return handleResponse(res, 400, 'No file provided. Use field name "file"');
        }

        const folder = resolveFolder(req);
        const uploaded = await uploadOneFile(req.file, folder);

        return handleResponse(res, 200, "File uploaded successfully", uploaded);
    } catch (error) {
        const status = error.statusCode || 500;
        return handleResponse(res, status, error.message);
    }
};

/**
 * POST /api/upload/multiple
 * multipart: files[] (max 10)
 * body/query: folder
 */
export const uploadMultiple = async (req, res) => {
    try {
        const files = req.files;
        if (!files?.length) {
            return handleResponse(
                res,
                400,
                'No files provided. Use field name "files"',
            );
        }

        const folder = resolveFolder(req);
        const uploads = [];
        const errors = [];

        for (let i = 0; i < files.length; i++) {
            try {
                const item = await uploadOneFile(files[i], folder);
                uploads.push(item);
            } catch (err) {
                errors.push({
                    index: i,
                    originalName: files[i].originalname,
                    message: err.message,
                });
            }
        }

        if (!uploads.length) {
            return handleResponse(res, 400, "All uploads failed", { errors });
        }

        return handleResponse(res, 200, "Upload completed", {
            uploads,
            count: uploads.length,
            failed: errors.length ? errors : undefined,
        });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

/** GET /api/upload/folders — list allowed folder names for clients */
export const listUploadFolders = (req, res) => {
    return handleResponse(res, 200, "Allowed upload folders", {
        root: CLOUDINARY_ROOT,
        folders: [...ALLOWED_MEDIA_FOLDERS],
    });
};
