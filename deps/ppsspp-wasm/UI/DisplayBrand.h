#pragma once

#include <string>
#include <string_view>

// Presentation only: keep upstream file formats, paths, API names and credits intact.
namespace DisplayBrand {
#if defined(__EMSCRIPTEN__)
inline constexpr const char *Name = "PPSSPW";
#else
inline constexpr const char *Name = "PPSSPP";
#endif

// Apply after translation, and only to copy that refers to this running application.
inline std::string AppText(std::string_view text) {
	std::string result(text);
#if defined(__EMSCRIPTEN__)
	size_t pos = 0;
	while ((pos = result.find("PPSSPP", pos)) != std::string::npos) {
		result.replace(pos, 6, Name);
		pos += 6;
	}
#endif
	return result;
}
}
