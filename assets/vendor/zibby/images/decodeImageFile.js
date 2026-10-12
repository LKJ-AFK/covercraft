let decoderModule;
const loadDecoder = () => {
    if (!decoderModule) {
        // The upstream ESM bundle embeds WASM; no worker, CDN, or asset URL is needed.
        // @ts-ignore libheif-js ships no TypeScript declarations for this entry.
        decoderModule = import("libheif-js/libheif-wasm/libheif-bundle.mjs")
            .then(module => module.default())
            .catch((error) => {
            decoderModule = undefined;
            throw error;
        });
    }
    return decoderModule;
};
/** Prepare a user image for the app's existing resize/preview pipeline.
 * HEIC/HEIF uses native decoding if available, otherwise the first image
 * is converted locally to JPEG. Other files pass through. */
export const decodeImageFile = async (file) => {
    const heic = file.type === "image/heic" || file.type === "image/heif" ||
        (file.type === "" && /\.(heic|heif)$/i.test(file.name));
    if (!heic)
        return file;
    if (typeof createImageBitmap === "function") {
        try {
            const bitmap = await createImageBitmap(file);
            bitmap.close();
            return file;
        }
        catch {
            // A browser exposing createImageBitmap need not support HEIC.
        }
    }
    const libheif = await loadDecoder();
    const decoder = new libheif.HeifDecoder();
    let images = [];
    try {
        images = decoder.decode(new Uint8Array(await file.arrayBuffer()));
        const image = images[0];
        if (!image)
            throw new Error("That HEIC/HEIF file contains no decodable image.");
        const canvas = document.createElement("canvas");
        canvas.width = image.get_width();
        canvas.height = image.get_height();
        const context = canvas.getContext("2d");
        if (!context)
            throw new Error("Could not create an image conversion canvas.");
        const pixels = context.createImageData(canvas.width, canvas.height);
        const displayed = await new Promise((resolve, reject) => {
            image.display(pixels, data => {
                if (data)
                    resolve(data);
                else
                    reject(new Error("Could not decode that HEIC/HEIF image."));
            });
        });
        context.putImageData(displayed, 0, 0);
        return await new Promise((resolve, reject) => {
            canvas.toBlob(blob => {
                if (blob)
                    resolve(blob);
                else
                    reject(new Error("Could not convert that HEIC/HEIF image to JPEG."));
            }, "image/jpeg", 0.92);
        });
    }
    finally {
        for (const image of images)
            image.free();
        if (decoder.decoder !== null) {
            libheif.heif_context_free(decoder.decoder);
            decoder.decoder = null;
        }
    }
};
