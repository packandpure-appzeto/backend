import Product from "../models/product.js";
import { slugify } from "./slugify.js";

function normalizeBase(value) {
  return String(value || "").trim() || "product";
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Generate a unique product slug from name (or base string).
 * Always returns lowercase slug safe for MongoDB unique index.
 */
export async function ensureUniqueSlug(baseSlug, excludeId = null) {
  const base = slugify(normalizeBase(baseSlug)) || "product";
  const suffix = Date.now().toString(36).slice(-4);

  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate =
      attempt === 0
        ? base
        : attempt < 50
          ? `${base}-${attempt + 1}`
          : `${base}-${suffix}-${attempt}`;

    const query = {
      slug: { $regex: new RegExp(`^${escapeRegex(candidate)}$`, "i") },
    };
    if (excludeId) query._id = { $ne: excludeId };

    const exists = await Product.exists(query);
    if (!exists) return candidate.toLowerCase();
  }

  return `${base}-${Date.now()}`.toLowerCase();
}

export function duplicateKeyMessage(error) {
  if (error?.code !== 11000) return null;
  const key = Object.keys(error.keyPattern || {})[0];
  if (key === "slug") return "A product with a similar name already exists. Try a slightly different title.";
  if (key === "sku") return "Legacy SKU index conflict — restart the API server to migrate indexes, then try again.";
  return `Duplicate value for ${key || "field"}`;
}
