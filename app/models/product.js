import mongoose from "mongoose";
import { PRODUCT_UNITS } from "../utils/productHelpers.js";

const variantSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    unit: {
      type: String,
      enum: PRODUCT_UNITS,
      default: "Pieces",
    },
    price: {
      type: Number,
      default: 0,
      min: 0,
    },
    salePrice: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Vendor / procurement cost for this variant (admin margin). */
    purchasePrice: {
      type: Number,
      default: 0,
      min: 0,
    },
    stock: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { _id: true },
);

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    description: {
      type: String,
      trim: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    salePrice: {
      type: Number,
      default: 0,
      min: 0,
    },
    purchasePrice: {
      type: Number,
      default: 0,
      min: 0,
    },
    stock: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    lowStockAlert: {
      type: Number,
      default: 5,
    },
    brand: {
      type: String,
      trim: true,
    },
    weight: {
      type: String,
      trim: true,
    },
    unit: {
      type: String,
      enum: PRODUCT_UNITS,
      default: "Pieces",
    },
    tags: [
      {
        type: String,
        trim: true,
      },
    ],
    mainImage: {
      type: String,
    },
    galleryImages: [
      {
        type: String,
      },
    ],
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    subcategoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    ownerType: {
      type: String,
      enum: ["seller", "admin"],
      default: "seller",
    },
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      default: null,
      required: function () {
        return this.ownerType !== "admin";
      },
    },
    status: {
      type: String,
      enum: ["pending_approval", "active", "inactive", "rejected"],
      default: "pending_approval",
    },
    variants: {
      type: [variantSchema],
      default: [],
    },
    isFeatured: {
      type: Boolean,
      default: false,
    },
    masterProductId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      default: null,
    },
  },
  { timestamps: true },
);

productSchema.index({ status: 1, isFeatured: 1, createdAt: -1 });
productSchema.index({ categoryId: 1, status: 1 });
productSchema.index({ subcategoryId: 1, status: 1 });
productSchema.index({ sellerId: 1, status: 1 });
productSchema.index({ ownerType: 1, status: 1, createdAt: -1 });
productSchema.index({ name: "text", tags: "text" });

/** Drop unique indexes for removed fields (sku, etc.) after schema changes. */
productSchema.statics.syncLegacyIndexes = async function syncLegacyIndexes() {
  const collection = this.collection;
  let indexes = [];
  try {
    indexes = await collection.indexes();
  } catch {
    return;
  }

  const dropKeys = ["sku", "headerId"];
  for (const idx of indexes) {
    const name = idx.name;
    if (!name || name === "_id_") continue;
    const shouldDrop = dropKeys.some((k) => Object.prototype.hasOwnProperty.call(idx.key || {}, k));
    if (!shouldDrop) continue;
    try {
      await collection.dropIndex(name);
      console.log(`[Product] Dropped legacy index: ${name}`);
    } catch (err) {
      if (err?.code !== 27) {
        console.warn(`[Product] Could not drop index ${name}:`, err.message);
      }
    }
  }
};

export default mongoose.model("Product", productSchema);
