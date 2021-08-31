# API

* `Swift.available`
    * Check whether the Swift API is available.
* `Swift.api`
    * Get JavaScript wrappers for public (and private) Swift runtime APIs.
* `Swift.modules`
    * List logical Swift modules. "Logical" because some internal Apple dylibs contain types that belong to different Swift modules. Module names also don't necessarily correspond to the name of the binary. E.g. they could be changed during compliation using the `-module-name <value>` option in the `swiftc` compiler.
* `Swift.classes`
    * Array containing classes available in all loaded binaries. Module-specfic classes could be retrieved using `Swift.modules.<module name>.classes`. Same for enums, structs and protocols.
    * Each object contains the following properties:
        * `$conformances`: array containing the protocols to which the class conforms.
        * `$fields`: array containing each field implemented by the class, along with its name, type and whether it's a constant.
        * `$methods`: array containing methods implemented by the class. Stripped methods don't contain the symbols, only their addresses and types (whether it's a getter, setter, constructor, etc.) and thus they require some reversing and guesswork to be instrumented, see `Swift.Interceptor`.
        * `$metadata`: an object that contains the name and the pointer of the class' metadata data structs, for your hacking pleasure.
        * `$moduleName`: the (logical, see `Swift.modules`) name of the module to which the class belongs.
        * Allocators which have symbols are callable as properties with a JS-friendly signature that separates the function from the argument list using `$` and replaces the Swift argument separator `:` with an `_`. E.g. a `SimpleClass` containing the constructor `init(first: Int, second: Int)` would be callable using `Swift.classes.SimpleClass.init$first_second_()`. The returned object is a `Swift.Object`.
* `Swift.structs`:
    * Array containing structs available in all loaded binaries.
    * Each object contains the following properties:
        * `$conformances`: see `Swift.classes`.
        * `$fields`: see, `Swift.classes`.
* `Swift.enums`:
    * Array containing enums available in all loaded binaries.
    * Each object contains the following properties:
        * `$conformances`: see `Swift.classes`.
        * `$fields`: an array containing the cases defined by the enum. Cases that have associated values have a `typeName` field for the type of the payload.
        * All cases are available as properties. Payload cases are available as functions whose one and only payload is the payload. E.g. `Swift.enums.CGPathFillRule.evenOdd` and `Swift.enums.UnicodeDecodingResult.scalarValue()`. The resulting `Swift.Enum` object can be passed to native Swift functions, see `Swift.NativeFunction`.
* `Swift.protocols`:
    * Array containing protocols available in all loaded binaries.
    * Each object contains the following properites:
        * `isClassOnly`: a boolean indicating whether the protocol is class-only, i.e. inhertis from `AnyObject`.
        * `numRequirements`: the number of requirements defined by the class.
* `new ObjC.Object(handle)`:
    * Create a JavaScript binding given an object existing at `handle`.
    * Instance methods are available as JavaScript properties but with a different signature, see `Swift.classes`.
    * Fields are available as JavaScript properties. These are get and set using the field's getter and setter methods generated by the compiler.
* `new Swift.Struct(struct, options)`:
    * Initialize a JavaScript wrapper for a native Swift struct value.
    * `struct` is a type object retrieved using the `Swift.structs` API.
    * `options` is an object containing either a `handle` or `raw` key. When `handle` is used, a JavaScript wrapper is created for the struct existing at `handle`, it's assumed that `handle` is unowned by the wrapper and it's the consumer's responsibility that the struct exists at `handle` at the time of usage. `raw` is an array containig pointer-sized fields that represent the struct's value as it's laid out in memory. E.g. a `Point` struct could be backed by two pointer-sized fields, so it'd be created using `new Swift.Struct(Point, { raw: [0xdead, 0xbabe] })`. Usage of this API could sometimes result in weird behavior because it doesn't currently handle constant fields (defined using `let`,) nor does it use the struct's "official" constructor. Use at your own risk.
* `new Swift.Enum(enum, options)`:
    * Initialize a JavaScript wrapper for a native Swift enum value.
    * This API is not not meant to be used in normal cases, as all enum values are available via convenience wrappers (see `Swift.enums`.)
    * `option` is an object containing either one of the keys: `handle` or `raw` or `tag `and `payload`.
        * `handle`: see `new Swift.Struct()`
        * `raw`: see `new Swift.Struct()`
        * `tag`: the raw case tag for the enum.
        * `payload`: the payload value, given that the tag is that of a payload case.
    * Has the following properties:
        * `$tag`: the raw tag value.
        * `$payload`: the payload value, given that the tag is that of a payload case.
* `new Swift.ProtocolComposition(protocols)`:
    * Create a new protocol that's the result of more than one protocol. This emulates the `&` syntax in Swift when defining a function, e.g:
        ```swift
        func wishHappyBirthday(to celebrator: Named & Aged) {
        		print("Happy birthday, \(celebrator.name), you're \(celebrator.age)!")
        }
        ```
    * Contains the same properties as the objects in `Swift.protocols`.
    * This object could be passed as a return or argument type for constructing a native Swift method wrapper, see `Swift.NativeFunction`.
* `Swift.NativeFunction(address, retType, argTypes[, context, error])`:
    * Create a native function that uses the Swiftcall calling convention and calls the function at `address`. `retType` is a type retrieved using one of the following:
        * APIs for enumerating types (e.g. `Swift.classes`, `Swift.struct`, etc.)
        * One of the objects in `Swift.protocols`.
        * A `Swift.ProtocolComposition` object.
    * This interface is compatible with the `new NativeFunction()` Frida API, so raw types could be used as well, e.g. `uint64`, `pointer`, etc. Same for the `argTypes` array.
    * `conetxt`: an optional parameter that emulates the `__attribute__((swift_context))` attribute offered by clang, see [this](https://gitlab.inria.fr/xfor/xfor-clang/-/blob/a422dde333dbe12dad36102b0e72126307a4c477/test/SemaCXX/attr-swiftcall.cpp) for an example.
    * `error`: an optional paramter that emulates the `__attribute__((swift_error_result))` clang attribute.
* `Swift.Interceptor.attach(target, callbacks)`:
    * `Interceptor`-like interface that maps arguments to their Swift counterparts, returning ready-made JavaScript wrappers (i.e. `Swift.Object`, `Swift.Struct`, `Swift.Enum`.)
    * A major caveat is that the function at `target` has to have a Swift symbol or either we bail. The symbol is required for the parsing of argument and return types.
    * Note: argument and return values are not currently replaceable using this API as they are in the original `Interceptor`.
