/**
 * TODO:
 *  - Use conventional ordering of declarations
 *  - Implement Objective-C enumeration, e.g. __C.NSURL?
 */

import { TargetClassDescriptor,
         TargetClassMetadata,
         TargetEnumDescriptor,
         TargetEnumMetadata,
         TargetProtocolDescriptor,
         TargetStructDescriptor,
         TargetStructMetadata,
         TargetTypeContextDescriptor,
         TargetValueMetadata,
         TypeLayout, } from "../abi/metadata";
import { MethodDescriptorKind,
         ProtocolClassConstraint } from "../abi/metadatavalues";
import { parseSwiftMethodSignature,
         resolveSymbolicReferences } from "../lib/symbols";
import { FieldDescriptor } from "../reflection/records";
import { getSymbolAtAddress } from "./symbols";
import { EnumValue,
         ValueInstance,
         StructValue,
         RuntimeInstance } from "./runtime";
import { Registry } from "./registry";
import { makeSwiftNativeFunction } from "./callingconvention";

type SwiftTypeKind = "Class" | "Enum" | "Struct";
type MethodType = "Init" | "Getter" | "Setter" | "ModifyCoroutine" |
                  "ReadCoroutine" | "Method";

interface FieldDetails {
    name: string;
    typeName?: string;
    isVar?: boolean;
}

interface MethodDetails {
    address: NativePointer;
    name: string;
    type: MethodType;
}

interface TypeProtocolConformance {
    protocol: TargetProtocolDescriptor,
    witnessTable: NativePointer,
}

export abstract class Type {
    readonly $name: string;
    readonly $fields?: FieldDetails[];
    readonly $moduleName: string;
    readonly $metadataPointer: NativePointer;
    readonly $conformances: Record<string, TypeProtocolConformance>;

    constructor (readonly module: Module,
                 readonly kind: SwiftTypeKind,
                 readonly descriptor: TargetTypeContextDescriptor) {
        this.$name = descriptor.name;
        this.$fields = getFieldsDetails(descriptor);
        this.$moduleName = descriptor.getModuleContext().name;
        this.$metadataPointer = descriptor.getAccessFunction()
                .call() as NativePointer;
        this.$conformances = {};
    }

    toJSON() {
        return {
            fields: this.$fields,
            conformances: Object.keys(this.$conformances),
        }
    }
}

export class Class extends Type {
    readonly $metadata: TargetClassMetadata;
    readonly $methods: MethodDetails[];

    constructor(module: Module, descriptorPtr: NativePointer) {
        const descriptor = new TargetClassDescriptor(descriptorPtr);
        super(module, "Class", descriptor);

        this.$metadata = new TargetClassMetadata(this.$metadataPointer);
        this.$methods = this.getMethodsDetails();
    }

    getMethodsDetails(): MethodDetails[] {
        const descriptor = this.descriptor as TargetClassDescriptor;
        const result: MethodDetails[] = [];

        for (const methDesc of descriptor.getMethodDescriptors()) {
            const address = methDesc.impl.get();
            const name = getSymbolAtAddress(this.module, address);
            const kind = methDesc.flags.getKind();
            let type: MethodType;

            switch (kind) {
                case MethodDescriptorKind.Init: {
                    type = "Init";
                    const parsed = parseSwiftMethodSignature(name);
                    if (parsed === undefined) {
                        break;
                    }

                    Object.defineProperty(this, parsed.methodName, {
                        configurable: true,
                        get() {
                            const argTypes = parsed.argTypeNames.map(ty =>
                                    Registry.shared().typeByName(ty));
                            const fn = makeSwiftNativeFunction(address, this,
                                    argTypes, this.$metadataPointer);

                            Object.defineProperty(this, parsed.methodName, {
                                value: fn,
                            });
                            return fn;
                        }
                    });
                    break;
                }
                case MethodDescriptorKind.Getter:
                    type = "Getter";
                    break;
                case MethodDescriptorKind.Setter:
                    type = "Setter";
                    break;
                case MethodDescriptorKind.ReadCoroutine:
                    type = "ReadCoroutine";
                    break;
                case MethodDescriptorKind.ModifyCoroutine:
                    type = "ModifyCoroutine";
                    break;
                case MethodDescriptorKind.Method:
                    type = "Method";
                    break;
                default:
                    throw new Error(`Invalid method descriptor kind: ${kind}`);
            }

            result.push({
                address,
                name,
                type,
            });
        }

        return result;
    }

    toJSON() {
        const base = super.toJSON();
        return Object.assign(base, {
            methods: this.$methods
        });
    }
}

export abstract class ValueType extends Type {
    readonly $metadata: TargetValueMetadata;
    readonly $typeLayout: TypeLayout;

    constructor(module: Module, kind: SwiftTypeKind,
                descriptor: TargetTypeContextDescriptor) {
        super(module, kind, descriptor);

        this.$metadata = new TargetValueMetadata(this.$metadataPointer);

        if (!this.descriptor.flags.isGeneric()) {
           this.$typeLayout = this.$metadata.getTypeLayout();
        }
    }

    $copyRaw(dest: NativePointer, src: NativePointer) {
        this.$metadata.vw_initializeWithCopy(dest, src);
    }

    $intializeWithCopyRaw(src: NativePointer): RuntimeInstance{
        const dest = this.makeEmptyValue();
        this.$metadata.vw_initializeWithCopy(dest.handle, src);
        return dest;
    }

    abstract makeValueFromRaw(buffer: NativePointer): ValueInstance;
    abstract makeEmptyValue(): RuntimeInstance;
}

export class Struct extends ValueType {
    readonly metadata: TargetStructMetadata;

    constructor(module: Module, descriptorPtr: NativePointer) {
        const descriptor = new TargetStructDescriptor(descriptorPtr);
        super(module, "Struct", descriptor);

        this.metadata = new TargetStructMetadata(this.$metadataPointer);
    }

    makeValueFromRaw(buffer: NativePointer): StructValue {
        return new StructValue(this, { handle: buffer });
    }

    makeEmptyValue(): StructValue {
        const buffer = Memory.alloc(this.$typeLayout.stride);
        return new StructValue(this, { handle: buffer });
    }
}

/* TODO: handle "default" protocol witnesses? See OnOffSwitch for an example */
export class Enum extends ValueType {
    readonly metadata: TargetEnumMetadata;

    constructor(module: Module, descriptroPtr: NativePointer) {
        const descriptor = new TargetEnumDescriptor(descriptroPtr);
        super(module, "Enum", descriptor);

        this.metadata = new TargetEnumMetadata(this.$metadataPointer);

        if (this.$fields === undefined) {
            return;
        }

        for (const [i, kase] of this.$fields.entries()) {
            const caseTag = i;

            if (descriptor.isPayloadTag(caseTag)) {
                const associatedValueWrapper = (payload: RuntimeInstance) => {
                    if (payload === undefined) {
                        throw new Error("Case requires an associated value");
                    }

                    /* TODO: type-check argument */
                    const enumValue = new EnumValue(this, {
                        tag: caseTag,
                        payload
                    });

                    return enumValue;
                }

                Object.defineProperty(this, kase.name, {
                    configurable: false,
                    enumerable: true,
                    value: associatedValueWrapper,
                    writable: false
                });
            } else {
                Object.defineProperty(this, kase.name, {
                    configurable: true,
                    enumerable: true,
                    get: () => {
                        const enumVal = new EnumValue(this, { tag: caseTag });
                        Object.defineProperty(this, kase.name, { value: enumVal });
                        return enumVal;
                    }
                });
            }
        }
    }

    makeValueFromRaw(buffer: NativePointer): EnumValue {
        return new EnumValue(this, { handle: buffer });
    }

    makeEmptyValue(): EnumValue {
        throw new Error("You're doing something wrong");
    }
}

export class Protocol {
    readonly name: string;
    readonly numRequirements: number;
    readonly isClassOnly: boolean;
    readonly moduleName: string;

    constructor(readonly descriptor: TargetProtocolDescriptor) {
        this.name = descriptor.name;
        this.numRequirements = descriptor.numRequirements;
        this.isClassOnly = descriptor.getProtocolContextDescriptorFlags()
                .getClassConstraint() == ProtocolClassConstraint.Class;
        this.moduleName = descriptor.getModuleContext().name;
    }

    toJSON() {
        return {
            numRequirements: this.descriptor.numRequirements,
            isClassOnly: this.isClassOnly,
        }
    }
}

export class ProtocolComposition {
    readonly protocols: Protocol[];
    readonly numProtocols: number;
    readonly isClassOnly: boolean;

    constructor(...protocols: Protocol[]) {
        this.protocols = [...protocols];
        this.numProtocols = protocols.length;
        this.isClassOnly = false;

        for (const proto of protocols) {
            if (proto.isClassOnly) {
                this.isClassOnly = true;
                break;
            }
        }
    }
}

function getFieldsDetails(descriptor: TargetTypeContextDescriptor): FieldDetails[] {
    const result: FieldDetails[] = [];

    if (!descriptor.isReflectable()) {
        return undefined;
    }

    const fieldsDescriptor = new FieldDescriptor(descriptor.fields.get());
    if (fieldsDescriptor.numFields === 0) {
        return undefined; 
    }

    const fields = fieldsDescriptor.getFields();
    for (const f of fields) {
        result.push({
            name: f.fieldName,
            typeName: f.mangledTypeName === null ?
                        undefined :
                        resolveSymbolicReferences(f.mangledTypeName.get()),
            isVar: f.isVar,
        });
    }

    return result;
}