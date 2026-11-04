#include <cassert>
#include <cstdio>
#include <initializer_list>

// Emscripten still compiles both fixtures. This variant exercises the existing
// non-web policy after standard headers have been included.
#ifdef TEST_DESKTOP_LAYOUT
#undef __EMSCRIPTEN__
#endif

enum class DeviceOrientation { Landscape, Portrait };
static DeviceOrientation orientation = DeviceOrientation::Landscape;
static DeviceOrientation GetDeviceOrientation() { return orientation; }
static struct DisplayMetrics { float dp_xres = 960; } g_display;

class UITabbedBaseDialogScreen {
public:
    bool UseHorizontalTabs() const;
    void resized();
    bool ForceHorizontalTabs() const { return forced; }
    void RecreateViews() { ++recreations; }

    bool forced = false;
    bool horizontalTabs_ = false;
    void *root_ = nullptr;
    int recreations = 0;
};

#include "production-tabbed-layout.inc"

int main() {
    UITabbedBaseDialogScreen screen;
    int checks = 0;
    const auto mode = [&](float width, bool expected) {
        g_display.dp_xres = width;
        assert(screen.UseHorizontalTabs() == expected);
        ++checks;
    };
#ifdef TEST_DESKTOP_LAYOUT
    constexpr bool narrow = false;
#else
    constexpr bool narrow = true;
#endif
    // The compact web canvas must not sacrifice 300 units to a side column.
    mode(280, narrow);
    mode(390, narrow);
    mode(719.5f, narrow);
    mode(720, false);
    mode(960, false);
    mode(0, false);
    mode(-1, false);

    orientation = DeviceOrientation::Portrait;
    mode(960, true);
    mode(0, true);
    orientation = DeviceOrientation::Landscape;
    screen.forced = true;
    mode(960, true);
    screen.forced = false;

    // Before views exist a resize cannot rebuild them.
    g_display.dp_xres = 390;
    screen.resized();
    assert(screen.recreations == 0);
    ++checks;
    screen.root_ = &screen;
    g_display.dp_xres = 960;
    screen.resized();
    assert(screen.recreations == 0);
    ++checks;

    g_display.dp_xres = 390;
    screen.resized();
    const int firstChange = narrow ? 1 : 0;
    assert(screen.recreations == firstChange);
    ++checks;
    // Model completed layout creation; repeated resizes in this mode preserve
    // the existing views instead of requesting another rebuild.
    screen.horizontalTabs_ = narrow;
    for (float width : {450.0f, 600.0f, 719.0f}) {
        g_display.dp_xres = width;
        screen.resized();
        assert(screen.recreations == firstChange);
        ++checks;
    }
    g_display.dp_xres = 960;
    screen.resized();
    assert(screen.recreations == firstChange * 2);
    ++checks;
    screen.horizontalTabs_ = false;
    screen.forced = true;
    screen.resized();
    assert(screen.recreations == firstChange * 2 + (narrow ? 1 : 0));
    ++checks;
    screen.horizontalTabs_ = true;
    screen.resized();
    assert(screen.recreations == firstChange * 2 + (narrow ? 1 : 0));
    ++checks;

#ifdef TEST_DESKTOP_LAYOUT
    std::printf("Desktop tab-layout policy: %d checks passed\n", checks);
#else
    std::printf("Web tab-layout policy: %d checks passed\n", checks);
#endif
}
