import mongoose from "mongoose";

const deliveryActivitySchema = new mongoose.Schema(
  {
    deliveryBoy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Delivery",
      required: true,
    },
    type: {
      type: String,
      enum: ["login", "logout", "online", "offline"],
      required: true,
    },
    location: {
      type: {
        type: String,
        enum: ["Point"],
        required: false,
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: false,
      },
    },
    area: {
      type: String,
      required: false,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false, // We only need createdAt, but we explicitly define it for clarity
  }
);

deliveryActivitySchema.index({ deliveryBoy: 1, createdAt: -1 });
deliveryActivitySchema.index({ location: "2dsphere" });

export default mongoose.model("DeliveryActivity", deliveryActivitySchema);
