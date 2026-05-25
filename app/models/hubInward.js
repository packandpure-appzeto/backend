import mongoose from "mongoose";

const inwardItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    expectedQty: { type: Number, default: 0, min: 0 },
    receivedQty: { type: Number, default: 0, min: 0 },
    damagedQty: { type: Number, default: 0, min: 0 },
    acceptedQty: { type: Number, default: 0, min: 0 },
    purchaseUnitCost: { type: Number, default: 0 },
    sellerProductId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
    qualityStatus: {
      type: String,
      enum: ["ok", "partial", "rejected"],
      default: "ok",
    },
  },
  { _id: false },
);

const hubInwardSchema = new mongoose.Schema(
  {
    purchaseRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseRequest",
      required: true,
      index: true,
    },
    hubId: {
      type: String,
      default: "MAIN_HUB",
      index: true,
    },
    receivedItems: {
      type: [inwardItemSchema],
      default: [],
    },
    verificationStatus: {
      type: String,
      enum: ["pending", "verified", "rejected"],
      default: "pending",
      index: true,
    },
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "receivedByModel",
    },
    receivedByModel: {
      type: String,
      enum: ["Admin", "Seller", "Delivery", "User"],
      default: "Admin",
    },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "verifiedByModel",
    },
    verifiedByModel: {
      type: String,
      enum: ["Admin", "Seller", "Delivery", "User"],
      default: "Admin",
    },
    verificationNotes: String,
    notes: String,
  },
  { timestamps: true },
);

hubInwardSchema.index({ purchaseRequestId: 1, createdAt: -1 });

export default mongoose.model("HubInward", hubInwardSchema);
