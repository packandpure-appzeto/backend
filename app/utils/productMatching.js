import mongoose from "mongoose";
import Product from "../models/product.js";
import {
  buildVariantSignature,
  normalizeProductName,
  mapVariantsForResponse,
} from "./productHelpers.js";

function escapeRegex(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find admin master catalog row matching product name + variant combination.
 * Same name with different variants is treated as a different product.
 */
export async function findMasterByNameAndVariants(
  { name, variants, unit, categoryId, subcategoryId, excludeId },
  opts = {},
) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) return null;

  const signature = buildVariantSignature(variants, unit);
  const query = {
    ownerType: "admin",
    name: { $regex: new RegExp(`^${escapeRegex(trimmedName)}$`, "i") },
  };

  if (categoryId && mongoose.Types.ObjectId.isValid(String(categoryId))) {
    query.categoryId = categoryId;
  }
  if (subcategoryId && mongoose.Types.ObjectId.isValid(String(subcategoryId))) {
    query.subcategoryId = subcategoryId;
  }
  if (excludeId && mongoose.Types.ObjectId.isValid(String(excludeId))) {
    query._id = { $ne: excludeId };
  }

  const candidates = await Product.find(query)
    .select(
      "name slug status price salePrice stock variants mainImage galleryImages categoryId subcategoryId unit brand weight description",
    )
    .lean();

  const match = candidates.find(
    (row) => buildVariantSignature(row.variants, row.unit) === signature,
  );

  if (!match) return null;

  if (opts.lean === false) {
    return Product.findById(match._id);
  }

  return match;
}

/** Map master row for API conflict / link responses. */
export function formatMasterMatchResponse(master) {
  if (!master) return null;
  const plain = typeof master.toObject === "function" ? master.toObject() : { ...master };
  return {
    ...plain,
    variants: mapVariantsForResponse(plain.variants),
  };
}

export function namesMatch(a, b) {
  return normalizeProductName(a) === normalizeProductName(b);
}
