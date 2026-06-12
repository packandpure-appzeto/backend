import ProductRequest from "../models/productRequest.js";
import handleResponse from "../utils/helper.js";

// @desc    Create a new product request
// @route   POST /api/product-requests
// @access  Private (Customer)
export const createProductRequest = async (req, res) => {
    try {
        const { productName, description } = req.body;
        
        if (!productName) {
            return handleResponse(res, 400, "Product name is required");
        }

        const newRequest = await ProductRequest.create({
            customer: req.user.id,
            productName,
            description,
        });

        return handleResponse(res, 201, "Product request submitted successfully", newRequest);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

// @desc    Get logged in user's product requests
// @route   GET /api/product-requests/my-requests
// @access  Private (Customer)
export const getCustomerProductRequests = async (req, res) => {
    try {
        const requests = await ProductRequest.find({ customer: req.user.id }).sort({ createdAt: -1 });
        return handleResponse(res, 200, "Fetched your product requests", requests);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

// @desc    Get all product requests with pagination, search, and filter
// @route   GET /api/product-requests
// @access  Private (Admin)
export const getAllProductRequests = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const { search, status } = req.query;

        let query = {};
        if (status && status !== "All") {
            query.status = status;
        }

        // We can search by productName or populate customer and search there.
        // For simplicity, we search by productName.
        if (search) {
            query.productName = { $regex: search, $options: "i" };
        }

        const total = await ProductRequest.countDocuments(query);
        const requests = await ProductRequest.find(query)
            .populate("customer", "name email phone")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        return handleResponse(res, 200, "Fetched all product requests", {
            items: requests,
            total,
            page,
            totalPages: Math.ceil(total / limit) || 1,
        });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

// @desc    Update product request status
// @route   PUT /api/product-requests/:id/status
// @access  Private (Admin)
export const updateProductRequestStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        const validStatuses = ["Pending", "Reviewed", "Approved", "Rejected"];
        if (!validStatuses.includes(status)) {
            return handleResponse(res, 400, "Invalid status");
        }

        const request = await ProductRequest.findById(id);
        if (!request) {
            return handleResponse(res, 404, "Product request not found");
        }

        request.status = status;
        await request.save();

        return handleResponse(res, 200, "Status updated successfully", request);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};
