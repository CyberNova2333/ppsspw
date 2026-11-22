// SPDX-License-Identifier: AGPL-3.0-only
// A PSP display list exercising signed viewport depth in the hardware transform path.
#include <pspdisplay.h>
#include <pspgu.h>
#include <pspkernel.h>

PSP_MODULE_INFO("Reversed viewport depth", 0, 1, 0);
PSP_MAIN_THREAD_ATTR(PSP_THREAD_ATTR_USER);

enum { WIDTH = 480, HEIGHT = 272, STRIDE = 512, BUFFER_BYTES = STRIDE * HEIGHT * 4 };
static unsigned int list[4096] __attribute__((aligned(16)));
static const ScePspFMatrix4 identity = {
    {1, 0, 0, 0}, {0, 1, 0, 0}, {0, 0, 1, 0}, {0, 0, 0, 1}
};

struct Vertex {
    unsigned int color;
    float x, y, z;
};

// The PSP stores color as ABGR. The left quad is closer after viewport reversal.
#define QUAD(color, left, right, z) \
    {{color, left, -.65f, z}, {color, right, -.65f, z}, \
     {color, left, .65f, z}, {color, right, .65f, z}}
static const struct Vertex front[] __attribute__((aligned(16))) = QUAD(0xff00ff00, -.72f, .16f, -.5f);
static const struct Vertex rear[] __attribute__((aligned(16))) = QUAD(0xff0000ff, -.16f, .72f, .5f);

int main(void) {
    sceGuInit();
    sceGuStart(GU_DIRECT, list);
    sceGuDrawBuffer(GU_PSM_8888, (void *)0, STRIDE);
    sceGuDispBuffer(WIDTH, HEIGHT, (void *)BUFFER_BYTES, STRIDE);
    sceGuDepthBuffer((void *)(2 * BUFFER_BYTES), STRIDE);
    sceGuOffset(2048 - WIDTH / 2, 2048 - HEIGHT / 2);
    sceGuViewport(2048, 2048, WIDTH, HEIGHT);
    sceGuScissor(0, 0, WIDTH, HEIGHT);
    sceGuEnable(GU_SCISSOR_TEST);
    sceGuEnable(GU_DEPTH_TEST);
    sceGuDepthMask(GU_FALSE);
    sceGuDepthFunc(GU_GEQUAL);
    // The affected map uses 7/8 to 1/16 of the 16-bit depth domain.
    sceGuDepthRange(57344, 4096);
    sceGuSetMatrix(GU_MODEL, &identity);
    sceGuSetMatrix(GU_VIEW, &identity);
    sceGuSetMatrix(GU_PROJECTION, &identity);
    sceGuFinish();
    sceGuSync(0, 0);
    sceGuDisplay(GU_TRUE);

    const int format = GU_COLOR_8888 | GU_VERTEX_32BITF | GU_TRANSFORM_3D;
    for (;;) {
        sceGuStart(GU_DIRECT, list);
        sceGuClearColor(0xff202020);
        sceGuClearDepth(0);
        sceGuClear(GU_COLOR_BUFFER_BIT | GU_DEPTH_BUFFER_BIT);
        sceGuDrawArray(GU_TRIANGLE_STRIP, format, 4, NULL, front);
        sceGuDrawArray(GU_TRIANGLE_STRIP, format, 4, NULL, rear);
        sceGuFinish();
        sceGuSync(0, 0);
        sceDisplayWaitVblankStart();
        sceGuSwapBuffers();
    }
}
