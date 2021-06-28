/**
 * TODO:
 *  - use a cleaner property-caching approach
 */

import { ContextDescriptorKind,
         MetadataKind,
         TargetValueWitnessFlags,
         TypeContextDescriptorFlags } from "./metadatavalues";
import { RelativePointer } from "../lib/helpers";

export interface TypeLayout {
    size: number,
    stride: number,
    flags: number,
    extraInhabitantCount: number,
}

export class TargetMetadata {
    static readonly OFFSETOF_KIND = 0x0;

    readonly kind: MetadataKind;

    constructor(public readonly handle: NativePointer) {
        this.kind = this.getKind();
    }

    getKind(): MetadataKind {
        return this.handle.add(TargetMetadata.OFFSETOF_KIND).readU32();
    }

    getValueWitnesses(): TargetValueWitnessTable {
        if (this.kind !== MetadataKind.Enum &&
            this.kind !== MetadataKind.Struct) {
            throw new Error(`Kind does not have a VWT: ${this.kind}`);
        }

        const handle = this.handle.sub(Process.pointerSize).readPointer();
        return new TargetValueWitnessTable(handle);
    }

    getTypeLayout(): TypeLayout {
        const valueWitnesses = this.getValueWitnesses();
        return {
            size: valueWitnesses.size,
            stride: valueWitnesses.stride,
            flags: valueWitnesses.flags.data,
            extraInhabitantCount: valueWitnesses.extraInhabitantCount,
        }
    }
}

class TargetValueWitnessTable {
    static readonly OFFSETOF_SIZE = 0x40;
    static readonly OFFSETOF_STRIDE = 0x48;
    static readonly OFFSETOF_FLAGS = 0x50;
    static readonly OFFSETOF_EXTRA_INHABITANT_COUNT = 0x54;

    readonly size: number;
    readonly stride: number;
    readonly flags: TargetValueWitnessFlags;
    readonly extraInhabitantCount: number;

    constructor (private handle: NativePointer) {
        this.size = this.getSize();
        this.stride = this.getStride();
        this.flags = this.getFlags();
        this.extraInhabitantCount = this.getExtraInhabitantCount();
    }

    getSize(): number {
        return this.handle.add(
            TargetValueWitnessTable.OFFSETOF_SIZE).readU64().toNumber();
    }

    getStride(): number {
		return this.handle.add(
			TargetValueWitnessTable.OFFSETOF_STRIDE).readU64().toNumber();
    }

    getFlags(): TargetValueWitnessFlags {
        const value = this.handle.add(
            TargetValueWitnessTable.OFFSETOF_FLAGS).readU32();
        return new TargetValueWitnessFlags(value);
    }

    getExtraInhabitantCount(): number {
		return this.handle.add(
			TargetValueWitnessTable.OFFSETOF_EXTRA_INHABITANT_COUNT).readU32();
    }
}

export class TargetContextDescriptor {
    static readonly OFFSETOF_FLAGS = 0x0;

    #flags: ContextDescriptorFlags;

    constructor(protected handle: NativePointer) {
    }

    get flags(): ContextDescriptorFlags {
        if (this.#flags != undefined) {
            return this.#flags;
        }

        const value = this.handle.add(TargetContextDescriptor.OFFSETOF_FLAGS)
            .readU32();
        return new ContextDescriptorFlags(value);
    }

    isGeneric(): boolean {
        return this.flags.isGeneric();
    }

    getKind(): ContextDescriptorKind {
        return this.flags.getKind();
    }
}

export class TargetTypeContextDescriptor extends TargetContextDescriptor {
    static readonly OFFSETOF_NAME = 0x8;
    static readonly OFFSETOF_ACCESS_FUNCTION_PTR = 0xC;
    static readonly OFFSETOF_FIELDS = 0x10;

    #name: string | undefined;
    #accessFunctionPtr: NativePointer;
    #fields: NativePointer | undefined;

    getTypeContextDescriptorFlags(): number {
        return this.flags.getKindSpecificFlags();
    }

    get name(): string {
        if (this.#name !== undefined) {
            return this.#name;
        }

        const namePtr = RelativePointer.resolveFrom(this.handle.add(
            TargetTypeContextDescriptor.OFFSETOF_NAME));
        return namePtr.readUtf8String();
    }

    get accessFunctionPointer(): NativePointer {
        if (this.#accessFunctionPtr !== undefined) {
            return this.#accessFunctionPtr;
        }

        return RelativePointer.resolveFrom(this.handle.add(
            TargetTypeContextDescriptor.OFFSETOF_ACCESS_FUNCTION_PTR));
    }

    get fields(): NativePointer {
        if (this.#fields !== undefined) {
            return this.#fields;
        }

        return RelativePointer.resolveFrom(this.handle.add(
            TargetTypeContextDescriptor.OFFSETOF_FIELDS));
    }

    isReflectable(): boolean {
        return this.fields !== null;
    }

    getAccessFunction(): NativeFunction {
        return new NativeFunction(this.accessFunctionPointer, "pointer", []);
    }
}

export class TargetClassDescriptor extends TargetTypeContextDescriptor {
    static readonly OFFSETOF_TARGET_VTABLE_DESCRIPTOR_HEADER = 0x2C;
    static readonly OFFSETOF_METHOD_DESCRIPTORS = 0x34;

    #methods: NativePointer[] | undefined;

    hasVTable(): boolean {
        return !!(this.getTypeContextDescriptorFlags() &
            (1 << TypeContextDescriptorFlags.Class_HasVTable));
    }

    getMethodDescriptors(): NativePointer {
        if (!this.hasVTable()) {
            return null;
        }

        return this.handle.add(TargetClassDescriptor.OFFSETOF_METHOD_DESCRIPTORS);
    }

    get methods(): NativePointer[] {
        if (this.#methods !== undefined) {
            return this.#methods;
        }

        /* TODO: handle generic contexts */
        if (!this.hasVTable() || this.isGeneric()) {
            return [];
        }

        const result: NativePointer[] = [];
        const vtableHeaderPtr = this.handle.add(
            TargetClassDescriptor.OFFSETOF_TARGET_VTABLE_DESCRIPTOR_HEADER);
        const vtableHeader = new VTableDescriptorHeader(vtableHeaderPtr);
        const vtableSize = vtableHeader.vtableSize;

        /* 4 is word size, so we assume 64-bit systems only for now */
        let i = this.getMethodDescriptors();
        const end = i.add(vtableSize * TargetMethodDescriptor.sizeof);

        for (; !i.equals(end); i = i.add(TargetMethodDescriptor.sizeof)) {
            const methodDescriptor = new TargetMethodDescriptor(i);

            /* TODO: figure out what the flags signify in this case */
            if (methodDescriptor.impl === null) {
                continue;
            }

            result.push(methodDescriptor.impl);
        }

        return result;
    }
}

class VTableDescriptorHeader {
    static readonly OFFSETOF_VTABLE_OFFSET = 0x0;
    static readonly OFFSETOF_VTABLE_SIZE = 0x4;

    #vtableSize: number | undefined;

    constructor(private handle: NativePointer) {
    }

    get vtableSize(): number {
        if (this.#vtableSize !== undefined) {
            return this.#vtableSize;
        }

        return this.handle.add(VTableDescriptorHeader.OFFSETOF_VTABLE_SIZE)
            .readU32();
    }
}

class TargetMethodDescriptor {
    static readonly OFFSETOF_FLAGS = 0x0;
    static readonly OFFSETOF_IMPL = 0x4;
    static sizeof = 8;

    #flags: number | undefined;
    #impl: NativePointer | undefined;

    constructor(private handle: NativePointer) {
    }

    get flags(): number {
        if (this.#flags !== undefined) {
            return this.#flags;
        }

        return this.handle.add(TargetMethodDescriptor.OFFSETOF_FLAGS).readU32();
    }

    get impl(): NativePointer {
        if (this.#impl !== undefined) {
            return this.#impl;
        }

        const pointer = this.handle.add(TargetMethodDescriptor.OFFSETOF_IMPL);
        return RelativePointer.resolveFrom(pointer);
    }
}

export class TargetStructDescriptor extends TargetTypeContextDescriptor {
    static readonly OFFSETOF_NUM_FIELDS = 0x18;
    static readonly OFFSETOF_FIELD_OFFSET_VECTOR_OFFSET = 0x1C;

    #numFields: number | undefined;
    #fieldOffsetVectorOffset: number | undefined;

    hasFieldOffsetVector(): boolean {
        return this.fieldOffsetVectorOffset !== 0;
    }

    get numFields(): number {
        if (this.#numFields !== undefined) {
            return this.#numFields;
        }

        return this.handle.add(TargetStructDescriptor.OFFSETOF_NUM_FIELDS)
            .readU32();
    }

    get fieldOffsetVectorOffset(): number {
        if (this.#fieldOffsetVectorOffset !== undefined) {
            return this.#fieldOffsetVectorOffset;
        }

        return this.handle.add(
            TargetStructDescriptor.OFFSETOF_FIELD_OFFSET_VECTOR_OFFSET).readU32();
    }
}

export class TargetEnumDescriptor extends TargetTypeContextDescriptor {
}

export interface FieldDetails {
    name: string;
    type?: string;
    isVar?: boolean;
}

class ContextDescriptorFlags {
    constructor (public readonly value: number) {
    }

    getKind(): ContextDescriptorKind {
        return this.value & 0x1F;
    }

    isGeneric(): boolean {
        return (this.value & 0x80) !== 0;
    }

    getIntValue(): number {
        return this.value;
    }

    getKindSpecificFlags(): number {
        return (this.value >>> 16) & 0xFFFF;
    }
}
