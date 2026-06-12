import mongoose from "mongoose";

const productRequestSchema = new mongoose.Schema(
    {
        customer: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        productName: {
            type: String,
            required: true,
            trim: true,
        },
        description: {
            type: String,
            trim: true,
            default: "",
        },
        status: {
            type: String,
            enum: ["Pending", "Reviewed", "Approved", "Rejected"],
            default: "Pending",
        },
    },
    { timestamps: true }
);

const ProductRequest = mongoose.model("ProductRequest", productRequestSchema);

export default ProductRequest;
