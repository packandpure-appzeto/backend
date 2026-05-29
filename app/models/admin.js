import mongoose from "mongoose";

const adminSchema = new mongoose.Schema(
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
      trim: true,
      unique: true,
      sparse: true,
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

    role: {
      type: String,
      default: "admin",
    },
    isVerified: {
      type: Boolean,
      default: true,
    },

    lastLogin: Date,
  },
  { timestamps: true },
);

// Plain-text compare (password stored as-is in `password` field — no bcrypt hook)
adminSchema.methods.comparePassword = async function (enteredPassword) {
  return enteredPassword === this.password;
};

export default mongoose.model("Admin", adminSchema);
