import mongoose from "mongoose";

const pickupPartnerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    vehicleType: {
      type: String,
      trim: true,
      default: "bike",
    },
    hubId: {
      type: String,
      default: "MAIN_HUB",
      index: true,
    },
    fcmTokens: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: ["available", "active", "inactive"],
      default: "available",
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    isVerified: {
      type: Boolean,
      default: true,
      index: true,
    },
    otp: {
      type: String,
      select: false,
    },
    otpExpiry: {
      type: Date,
      select: false,
    },
    lastLogin: Date,
    role: {
      type: String,
      default: "pickup_partner",
    },

    // Payment Configuration
    paymentType: {
      type: String,
      enum: ["salary", "per_trip"],
      default: "per_trip",
    },
    salaryAmount: {
      type: Number,
      default: 0,
    },
    perKmRate: {
      type: Number,
      default: 10, // ₹10 per km
    },
    baseTripRate: {
      type: Number,
      default: 20, // ₹20 base per trip
    },
    walletBalance: {
      type: Number,
      default: 0,
    },
    address: {
      type: String,
      trim: true,
      default: ""
    },
    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point"
      },
      coordinates: {
        type: [Number],
        default: [0, 0] // [longitude, latitude]
      }
    }
  },
  { timestamps: true },
);

pickupPartnerSchema.index({ location: "2dsphere" });

pickupPartnerSchema.index({ phone: 1 }, { unique: true });
pickupPartnerSchema.index({ hubId: 1, status: 1 });

export default mongoose.model("PickupPartner", pickupPartnerSchema);
