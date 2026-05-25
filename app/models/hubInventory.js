import mongoose from "mongoose";

const hubInventorySchema = new mongoose.Schema(
  {
    hubId: {
      type: String,
      default: "MAIN_HUB",
      index: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    sku: {
      type: String,
      trim: true,
    },
    /** Hub sellable qty. For multi-variant catalog products, kept in sync with sum of Product.variants[].stock. */
    availableQty: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    reservedQty: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    reorderLevel: {
      type: Number,
      default: 10,
      min: 0,
    },
    status: {
      type: String,
      enum: ["healthy", "low_stock", "out_of_stock"],
      default: "healthy",
    },
    lastPurchaseCost: {
      type: Number,
      default: 0,
      min: 0,
    },
    avgPurchaseCost: {
      type: Number,
      default: 0,
      min: 0,
    },
    marginType: {
      type: String,
      enum: ["percent", "flat"],
      default: "percent",
    },
    marginValue: {
      type: Number,
      default: 15,
      min: 0,
    },
    sellPrice: {
      type: Number,
      default: 0,
      min: 0,
    },
    priceUpdatedAt: {
      type: Date,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "updatedByModel",
    },
    updatedByModel: {
      type: String,
      enum: ["Admin", "Seller", "Delivery", "User"],
    },
  },
  { timestamps: true },
);

hubInventorySchema.index({ hubId: 1, productId: 1 }, { unique: true });

export default mongoose.model("HubInventory", hubInventorySchema);
