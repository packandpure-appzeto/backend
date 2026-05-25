import { v2 as cloudinary } from "cloudinary";
import dotenv from "dotenv";

dotenv.config();

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const CLOUDINARY_ROOT = (
    process.env.CLOUDINARY_ROOT_FOLDER || "pack-and-pure"
).replace(/\/+$/, "");

/** Top-level folders — keeps uploads organized and prevents arbitrary paths */
export const ALLOWED_MEDIA_FOLDERS = new Set([
    "products",
    "categories",
    "customers",
    "sellers",
    "seller-docs",
    "seller_docs",
    "delivery",
    "delivery-docs",
    "delivery_docs",
    "pickup",
    "pickup-proofs",
    "settings",
    "experience",
    "experience-banners",
    "reviews",
    "tickets",
    "offers",
    "misc",
]);

/**
 * @param {string} folder - e.g. "products" or "customers/avatars"
 * @returns {string} Cloudinary folder path
 */
export const sanitizeMediaFolder = (folder) => {
    const raw = String(folder || "misc")
        .trim()
        .toLowerCase()
        .replace(/\\/g, "/")
        .replace(/[^a-z0-9/_-]/g, "")
        .replace(/\/{2,}/g, "/")
        .replace(/^\/+|\/+$/g, "");

    const topLevel = raw.split("/")[0] || "misc";
    const safeTop = ALLOWED_MEDIA_FOLDERS.has(topLevel) ? topLevel : "misc";
    const subPath = raw.includes("/") ? raw.slice(raw.indexOf("/") + 1) : "";
    const subSafe = subPath
        ? subPath
              .split("/")
              .slice(0, 2)
              .filter(Boolean)
              .join("/")
        : "";

    return subSafe
        ? `${CLOUDINARY_ROOT}/${safeTop}/${subSafe}`
        : `${CLOUDINARY_ROOT}/${safeTop}`;
};

export const formatCloudinaryResult = (result) => ({
    url: result.secure_url,
    publicId: result.public_id,
    resourceType: result.resource_type,
    format: result.format,
    width: result.width,
    height: result.height,
    bytes: result.bytes,
    folder: result.folder,
    duration: result.duration,
    createdAt: result.created_at,
});

/**
 * Upload a buffer to Cloudinary (images, videos, PDFs via resource_type auto).
 * @param {Buffer} fileBuffer
 * @param {{ folder?: string, resourceType?: string, mimetype?: string }} options
 */
export const uploadBufferToCloudinary = async (
    fileBuffer,
    { folder = "misc", resourceType = "auto", mimetype } = {},
) => {
    const cloudFolder = sanitizeMediaFolder(folder);
    const isVideo = mimetype?.startsWith("video/");
    const resolvedType =
        resourceType === "auto"
            ? isVideo
                ? "video"
                : "auto"
            : resourceType;

    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder: cloudFolder,
                resource_type: resolvedType,
                use_filename: true,
                unique_filename: true,
                overwrite: false,
            },
            (error, result) => {
                if (error) return reject(error);
                resolve(formatCloudinaryResult(result));
            },
        );
        uploadStream.end(fileBuffer);
    });
};

/** @deprecated Prefer uploadBufferToCloudinary — returns URL string only */
export const uploadToCloudinary = async (fileBuffer, folder = "categories") => {
    const result = await uploadBufferToCloudinary(fileBuffer, { folder });
    return result.url;
};

export default cloudinary;
