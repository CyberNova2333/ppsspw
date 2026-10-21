set(GIT_VERSION_FILE "${OUTPUT_DIR}/git-version.cpp")
set(GIT_VERSION_WASM "0")
if(NOT DEFINED GIT_VERSION_FALLBACK)
	set(GIT_VERSION_FALLBACK "unknown")
elseif(GIT_VERSION_FALLBACK STREQUAL "wasm")
	set(GIT_VERSION_WASM "1")
	set(GIT_VERSION_FALLBACK "0.0.0-wasm")
	if(EXISTS "${SOURCE_DIR}/README.md")
		file(STRINGS "${SOURCE_DIR}/README.md" PPSSPP_RELEASE_VERSION_LINES
			REGEX "^What's new in [0-9]+\\.[0-9]+(\\.[0-9]+)?")
		list(LENGTH PPSSPP_RELEASE_VERSION_LINES PPSSPP_RELEASE_VERSION_LINE_COUNT)
		if(PPSSPP_RELEASE_VERSION_LINE_COUNT GREATER 0)
			list(GET PPSSPP_RELEASE_VERSION_LINES 0 PPSSPP_RELEASE_VERSION_LINE)
			string(REGEX REPLACE "^What's new in ([0-9]+\\.[0-9]+(\\.[0-9]+)?).*" "\\1-wasm" GIT_VERSION_FALLBACK "${PPSSPP_RELEASE_VERSION_LINE}")
		endif()
	endif()
endif()
set(GIT_VERSION "${GIT_VERSION_FALLBACK}")
set(GIT_VERSION_UPDATE "1")

find_package(Git)
if(GIT_FOUND AND EXISTS "${SOURCE_DIR}/.git")
	if(GIT_VERSION_WASM)
		execute_process(COMMAND ${GIT_EXECUTABLE} describe --tags --match v* --abbrev=0
			WORKING_DIRECTORY ${SOURCE_DIR}
			RESULT_VARIABLE exit_code
			OUTPUT_VARIABLE GIT_VERSION_OUTPUT
			ERROR_QUIET)
		if(${exit_code} EQUAL 0)
			string(STRIP "${GIT_VERSION_OUTPUT}" GIT_VERSION_OUTPUT)
			string(REGEX REPLACE "^v" "" GIT_VERSION_OUTPUT "${GIT_VERSION_OUTPUT}")
			set(GIT_VERSION "${GIT_VERSION_OUTPUT}")
		endif()
	else()
		execute_process(COMMAND ${GIT_EXECUTABLE} describe --always
			WORKING_DIRECTORY ${SOURCE_DIR}
			RESULT_VARIABLE exit_code
			OUTPUT_VARIABLE GIT_VERSION_OUTPUT
			ERROR_QUIET)
		if(NOT ${exit_code} EQUAL 0)
			message(WARNING "git describe failed, unable to include version.")
		else()
			set(GIT_VERSION "${GIT_VERSION_OUTPUT}")
		endif()
	endif()
	string(STRIP "${GIT_VERSION}" GIT_VERSION)
else()
	if(NOT GIT_VERSION_WASM)
		message(WARNING "git not found or source is not a git checkout, unable to include git version.")
	endif()
endif()

string(STRIP "${GIT_VERSION}" GIT_VERSION)
if(GIT_VERSION_WASM AND NOT GIT_VERSION MATCHES "-wasm$")
	set(GIT_VERSION "${GIT_VERSION}-wasm")
endif()

if(EXISTS ${GIT_VERSION_FILE})
	# Don't update if marked not to update.
	file(STRINGS ${GIT_VERSION_FILE} match
		REGEX "PPSSPP_GIT_VERSION_NO_UPDATE 1")
	if(NOT ${match} EQUAL "")
		set(GIT_VERSION_UPDATE "0")
	endif()

	# Let's also skip if it's the same.
	string(REPLACE "." "\\." GIT_VERSION_ESCAPED ${GIT_VERSION})
	file(STRINGS ${GIT_VERSION_FILE} match
		REGEX "PPSSPP_GIT_VERSION = \"${GIT_VERSION_ESCAPED}\";")
	if(NOT ${match} EQUAL "")
		set(GIT_VERSION_UPDATE "0")
	endif()
endif()

set(code_string "// This is a generated file.\n\n"
	"const char *PPSSPP_GIT_VERSION = \"${GIT_VERSION}\"\;\n\n"
	"// If you don't want this file to update/recompile, change to 1.\n"
	"#define PPSSPP_GIT_VERSION_NO_UPDATE 0\n")

if ("${GIT_VERSION_UPDATE}" EQUAL "1")
	file(WRITE ${GIT_VERSION_FILE} ${code_string})
endif()
