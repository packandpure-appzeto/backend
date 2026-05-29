import mongoose from "mongoose";

const sellerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    phone: {
      type: String,
      required: true,
      unique: true,
    },

    password: {
      type: String,
      required: true,
      select: false,
    },

    otp: {
      type: String,
      select: false,
    },

    otpExpiry: {
      type: Date,
      select: false,
    },

    shopName: {
      type: String,
      required: true,
      trim: true,
    },

    address: {
      type: String,
      default: "",
    },

    role: {
      type: String,
      default: "seller",
    },

    isVerified: {
      type: Boolean,
      default: false,
    },

    isActive: {
      type: Boolean,
      default: true,
    },
    fcmTokens: {
      type: [String],
      default: [],
    },
    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number],
        default: [0, 0],
      },
    },
    serviceRadius: {
      type: Number,
      default: 5,
    },
    documents: {
      tradeLicense: String,
      gstCertificate: String,
      idProof: String,
    },
    category: {
      type: String,
      default: "General",
    },
    description: {
      type: String,
      default: "",
    },
    lastLogin: Date,
  },

  { timestamps: true },
);

sellerSchema.index({ location: "2dsphere" });
sellerSchema.index({ isActive: 1, isVerified: 1 });
sellerSchema.index({ email: 1 }, { unique: true });
sellerSchema.index({ phone: 1 }, { unique: true });

sellerSchema.methods.comparePassword = async function (enteredPassword) {
  return enteredPassword === this.password;
};

export default mongoose.model("Seller", sellerSchema);
