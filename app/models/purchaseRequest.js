import mongoose from "mongoose";

const purchaseRequestItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    requiredQty: {
      type: Number,
      required: true,
      min: 1,
    },
    availableQtyAtHub: {
      type: Number,
      default: 0,
      min: 0,
    },
    shortageQty: {
      type: Number,
      required: true,
      min: 1,
    },
    committedQty: {
      type: Number,
      min: 0,
      default: 0,
    },
    selectedSellerProductId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
    },
    vendorUnitCost: {
      type: Number,
      min: 0,
      default: 0,
    },
    vendorQuotedPrice: {
      type: Number,
      min: 0,
      default: 0,
    },
    pricingStrategy: {
      type: String,
      trim: true,
      default: "",
    },
    gstRate: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 },
  },
  { _id: false },
);

const purchaseRequestSchema = new mongoose.Schema(
  {
    requestId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      index: true,
    },
    hubId: {
      type: String,
      default: "MAIN_HUB",
      index: true,
    },
    items: {
      type: [purchaseRequestItemSchema],
      default: [],
    },
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      index: true,
    },
    pickupPartnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PickupPartner",
    },
    status: {
      type: String,
      enum: [
        "created",
        "vendor_confirmed",
        "pickup_assigned",
        "picked",
        "hub_delivered",
        "received_at_hub",
        "verified",
        "closed",
        "cancelled",
        "exception",
      ],
      default: "created",
      index: true,
    },
    vendorResponse: {
      status: {
        type: String,
        enum: ["pending", "accepted", "rejected", "partial"],
        default: "pending",
      },
      respondedAt: Date,
      rejectionReason: String,
      notes: String,
    },
    vendorReadyAt: Date,
    vendorReadyNotes: String,
    vendorHandover: {
      confirmedAt: Date,
      otpVerifiedAt: Date,
      notes: String,
    },
    pickupOtpHash: String,
    pickupOtpCode: String,
    pickupOtpExpiresAt: Date,
    pickupOtpVerifiedAt: Date,
    pickupProof: {
      pickedAt: Date,
      pickedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "PickupPartner",
      },
      vendorImageUrl: String,
      notes: String,
      location: {
        lat: Number,
        lng: Number,
      },
    },
    hubDropProof: {
      droppedAt: Date,
      droppedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "PickupPartner",
      },
      hubImageUrl: String,
      notes: String,
      location: {
        lat: Number,
        lng: Number,
      },
    },
    exceptionReason: String,
    eta: Date,
    notes: String,
  },
  { timestamps: true },
);

purchaseRequestSchema.index({ orderId: 1, vendorId: 1, createdAt: -1 });

export default mongoose.model("PurchaseRequest", purchaseRequestSchema);
