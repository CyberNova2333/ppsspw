#include <cassert>
#include <cmath>
#include <cstdio>
#include <initializer_list>

using Uint32 = unsigned int;
constexpr Uint32 SDL_WINDOW_FULLSCREEN = 1;
constexpr Uint32 SDL_WINDOW_FULLSCREEN_DESKTOP = 4097;
constexpr int SDL_DISABLE = 0, SDL_ENABLE = 1, UISTATE_INGAME = 1;
enum class GPUBackend { OPENGL, VULKAN };
struct SDL_Window { int width, height, drawableWidth; Uint32 flags = 0; };
struct SDL_Event { struct { int data1, data2; } window; };
struct {
	int iGPUBackend = (int)GPUBackend::OPENGL;
	int iUIScaleFactor = 0;
	bool bFullScreen = false;
	int iWindowWidth = 0, iWindowHeight = 0;
	bool bShowTouchControls = true;
} g_Config;
float g_DesktopDPI = 1;
int lastUIState = 0;
struct { int calls = 0, width = 0, height = 0; float dpi = 0; } applied;
int cursor = SDL_ENABLE;

void SDL_GetWindowSize(SDL_Window *window, int *width, int *height) {
	*width = window->width;
	*height = window->height;
}
void SDL_GL_GetDrawableSize(SDL_Window *window, int *width, int *) { *width = window->drawableWidth; }
Uint32 SDL_GetWindowFlags(SDL_Window *window) { return window->flags; }
void Native_NotifyWindowHidden(bool hidden) { assert(!hidden); }
float UIScaleFactorToMultiplier(int) { return 1; }
void Native_UpdateScreenScale(int width, int height, float) {
	++applied.calls;
	applied.width = width;
	applied.height = height;
	applied.dpi = g_DesktopDPI;
}
void SDL_ShowCursor(int value) { cursor = value; }

// These two bodies come directly from SDLMain.cpp, not a reimplementation.
#include "production-resize.inc"

int main() {
	int cases = 0;
	for (const SDL_Window sample : {
		SDL_Window{360, 640, 1080}, SDL_Window{720, 640, 1440},
		SDL_Window{640, 360, 1920}, SDL_Window{800, 600, 1000},
		SDL_Window{320, 240, 320},
	}) {
		SDL_Window window = sample;
		const int before = applied.calls;
		Resize(&window, {{window.width, window.height}});
		assert(applied.calls == before + 1);
		const float expectedDpi = (window.drawableWidth + 1.0f) / window.width;
		assert(std::abs(applied.dpi - expectedDpi) < 0.00001f);
		assert(applied.dpi == g_DesktopDPI);
		// Preserve the existing one-pixel rounding convention at fractional DPR.
		assert(std::abs(applied.width - window.drawableWidth) <= 1);
		assert(applied.height == (int)(window.height * expectedDpi));
		assert(g_Config.iWindowWidth == window.width && g_Config.iWindowHeight == window.height);
		++cases;
	}

	SDL_Window fullscreen{400, 300, 800, SDL_WINDOW_FULLSCREEN_DESKTOP};
	g_DesktopDPI = 1;
	g_Config.bFullScreen = false;
	Resize(&fullscreen, {{400, 300}});
	assert(g_Config.bFullScreen && applied.dpi > 2 && applied.width == 801);
	++cases;
	fullscreen.flags = 0;
	fullscreen.drawableWidth = 400;
	Resize(&fullscreen, {{400, 300}});
	assert(!g_Config.bFullScreen && applied.dpi < 1.01f && applied.width == 401);
	++cases;

	for (const SDL_Event event : {SDL_Event{{0, 300}}, SDL_Event{{400, 0}}, SDL_Event{{-1, 300}}}) {
		const int before = applied.calls;
		Resize(&fullscreen, event);
		assert(applied.calls == before);
		++cases;
	}
	for (const SDL_Window sample : {SDL_Window{0, 300, 800}, SDL_Window{400, 0, 800}, SDL_Window{400, 300, 0}}) {
		SDL_Window window = sample;
		g_DesktopDPI = 2;
		UpdateScreenDPI(&window);
		assert(g_DesktopDPI == 2 && std::isfinite(g_DesktopDPI));
		++cases;
	}
	std::printf("SDL viewport: %d resize/DPI cases passed (stubbed SDL, no browser rendering)\n", cases);
}
